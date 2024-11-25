const util = require('util');
const path = require('path');
const exec = util.promisify(require('child_process').exec);
const { fork, spawn } = require('child_process');
const fs = require('fs/promises');
const { once } = require('events');
const readline = require('readline');
const { stdin: input, stdout: output } = require('process');

const ergogenCli = path.resolve(require.resolve('ergogen'), '../cli.js');
const openjscadCli = path.resolve(require.resolve('@jscad/openjscad'), '../cli/cli.js');

const [generatePcbImage, generateGerber] = spawnPcbImageProcess();
const [exportDsn, importSes] = spawnConvertKicadPcbToDSNProcess();
const freeRouting = freeRoutingProcess();

const generate = (async (input) => {
  fs.rm('output/pcbs/board.dsn', { force: true });
  fs.rm('output/routed_pcbs/board.ses', { force: true });
  fs.rm('output/routed_pcbs/board.kicad_pcb', { force: true });
  fs.mkdir('output/routed_pcbs', { recursive: true });
  fs.mkdir('output/gerbers', { recursive: true });
  console.log('building...');
  await once(fork(ergogenCli, ['-d', '.'], {}), 'close');

  await Promise.all([
    ...(!['all', 'stl'].includes(input) ? [] : ['case_stl', 'base_stl', 'left_plate_stl', 'right_plate_stl', 'switch_tester_stl']
      .map(file => once(fork(openjscadCli, [`output/cases/${file}.jscad`, '-o', `output/cases/${file}.stl`], {}), 'close'))),
    ...(!['all', 'pic'].includes(input) ? [] : [generatePcbImage('pcbs/board')]),
    ...(input === 'all' ? [routePcb()] : []),
  ]);
});

process.on('exit', () => {
  console.log('exiting');
});
process.on('SIGINT', () => {
  console.log('exiting');
  process.exit();
});

let lastInput = 'all';
generate(lastInput);
const rl = readline.createInterface({ input, output });
rl.on('line', (input) => {
  if (input === 'exit') {
    process.exit();
  }
  console.log(input);
  generate(lastInput = input || lastInput);
  console.log(lastInput);
});

rl.on("SIGINT", function () {
  process.emit("SIGINT");
});

async function exists(...files) {
  try {
    await Promise.all(files.map(file => fs.access(file)));
    return true;
  } catch {
    return false;
  }
}

async function retry(callback, ...files) {
  let retryCount = 0;
  do {
    if (retryCount > 0) {
      console.log(`could not find ${files[0]}, command attempted ${retryCount} times`);
    }
    await callback();
    retryCount++;
  } while(await exists(...files) === false);
}

async function onceMessage(process, message) {
  return new Promise(resolve => {
    const listener = (data) => {
      if (data.includes(message)) {
        resolve();
        process.stdout.off('data', listener);
      }
    };
    process.stdout.on('data', listener);
  });
}

async function spawnDockerImage(identifier, image) {
  console.log(`spawning ${identifier} docker image`);
  const spawnMessage = `${identifier} spawned`;
  const pcbImageProcess = spawn('docker', [
    'run',
    '-i',
    '-w /board',
    `-v ${__dirname}:/board`,
    `-v ${__dirname}\\tmp:/tmp`,
    '--rm',
    '--entrypoint', '/bin/bash',
    image,
    '-c',
    `"echo ${spawnMessage}; /bin/bash"`,
  ], { shell: true });
  const spawnedPromise = onceMessage(pcbImageProcess, spawnMessage);

  pcbImageProcess.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });
  pcbImageProcess.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });
  pcbImageProcess.stdin.setEncoding('utf8');
  process.on('exit', () => {
    pcbImageProcess.stdin.end();
    pcbImageProcess.kill();
  });
  process.on('SIGINT', () => {
    pcbImageProcess.stdin.end();
    pcbImageProcess.kill();
  });
  await spawnedPromise;
  return pcbImageProcess;
}

function spawnPcbImageProcess() {
  const processPromise = spawnDockerImage('pcb imager', 'yaqwsx/kikit:v1.3.0');
  const imageGenerator = async (pcbPath) => {
    const pcbImageProcess = await processPromise;

    const finishMessage = `done generating ${pcbPath} images`;
    const imagePromise = onceMessage(pcbImageProcess, finishMessage);
    console.log(`generating ${pcbPath} images`);
    pcbImageProcess.stdin.write(`${['front', 'back'].map(side => [
      '/usr/local/bin/pcbdraw',
      'plot',
      '--side', side,
      '--style', 'oshpark-afterdark',
      `output/${pcbPath}.kicad_pcb`,
      `output/${pcbPath}-${side}.png`,
    ].join(' ')).join(';')}; echo ${finishMessage}\n`);

    await imagePromise;
    console.log(finishMessage);
  }

  const gerberGenerator = async () => {
    const converterProcess = await processPromise;
    console.log('exporting gerbers');
    const finishMessage = 'export gerbers done';
    const onceMessagePromise = onceMessage(converterProcess, finishMessage);
    converterProcess.stdin.write([
      [
        '/usr/local/bin/kikit',
        'fab',
        'jlcpcb',
        '--no-drc',
        '--no-assembly',
        'output/routed_pcbs/board.kicad_pcb',
        'output/gerbers/board'
      ].join(' '),
      `echo ${finishMessage}\n`,
    ].join('; '));
    await onceMessagePromise;
    console.log('exported gerbers');
  }

  return [imageGenerator, gerberGenerator];
}


async function routePcb() {
  await Promise.all([retry(exportDsn, 'output/pcbs/board.dsn')]);
  await freeRouting();
  await retry(importSes, 'output/routed_pcbs/board.kicad_pcb');
  await Promise.all([generateGerber(), generatePcbImage('routed_pcbs/board')]);
}

function spawnConvertKicadPcbToDSNProcess() {
  const processPromise = spawnDockerImage('pcb converter', 'soundmonster/kicad-automation-scripts:latest')
    .then(async converterProcess => {
      const finishMessage = 'convert docker image ready';
      const onceMessagePromise = onceMessage(converterProcess, finishMessage);
      converterProcess.stdin.write([
        'cp /board/import_ses.py /usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/import_ses.py',
        'cp /board/export_dsn.py /usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/export_dsn.py',
        `echo ${finishMessage}\n`,
      ].join('; '));
      await onceMessagePromise;
      return converterProcess;
    });

  const exportDsn = async () => {
    const converterProcess = await processPromise;
    console.log('exporting dsn');
    const finishMessage = 'export dsn done';
    const onceMessagePromise = onceMessage(converterProcess, finishMessage);
    converterProcess.stdin.write([
      '/usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/export_dsn.py --record output/pcbs/board.kicad_pcb output/pcbs/board.dsn', // add --record to record a video
      `echo ${finishMessage}\n`,
    ].join('; '));
    await onceMessagePromise;
    console.log('exported dsn');
  }

  const importSes = async () => {
    const converterProcess = await processPromise;
    console.log('importing ses');
    const finishMessage = 'export dsn done';
    const onceMessagePromise = onceMessage(converterProcess, finishMessage);
    converterProcess.stdin.write([
      '/usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/import_ses.py --record output/pcbs/board.kicad_pcb output/routed_pcbs/board.ses --output-file output/routed_pcbs/board.kicad_pcb', // add --record to record a video
      `echo ${finishMessage}\n`,
    ].join('; '));
    await onceMessagePromise;
    console.log('imported ses');
  }

  return [exportDsn, importSes];
}

function freeRoutingProcess() {
  const processPromise = spawnDockerImage('free routing', 'soundmonster/freerouting_cli:v0.1.0')
    .then(process => {
      process.stdout.on('data', (data) => {
        if (data.includes('FRCLI--PROGRESS')) {
          console.log(`${data}`);
        }
      });
      return process;
    });

  return async () => {
    const routingProcess = await processPromise;
    console.log('routing pcb');
    const finishMessage = 'routing pcb done';
    const onceMessagePromise = onceMessage(routingProcess, finishMessage);
    routingProcess.stdin.write([
      [
        'java', '-jar', '/opt/freerouting_cli.jar',
        '-de', 'output/pcbs/board.dsn',
        '-do', 'output/routed_pcbs/board.ses',
      ].join(' '),
      `echo ${finishMessage}\n`,
    ].join('; '));
    await onceMessagePromise;
    console.log('routed pcb');
  }
}
