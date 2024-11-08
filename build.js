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

const generatePcbImage = spawnPcbImageProcess();

const generate = (async () => {
  fs.rm('output/pcbs/board.dsn', { force: true });
  fs.rm('output/routed_pcbs/board.ses', { force: true });
  fs.rm('output/routed_pcbs/board.kicad_pcb', { force: true });
  console.log('building...');
  await once(fork(ergogenCli, ['-d', '.'], {}), 'close');

  await Promise.all([
    ...['case_stl', 'base_stl', 'plate_stl']
      .map(file => once(fork(openjscadCli, [`output/cases/${file}.jscad`, '-o', `output/cases/${file}.stl`], {}), 'close')),
    generatePcbImage('pcbs/board'),
    routePcb(generatePcbImage),
  ]);
});
generate();

process.on('exit', () => {
  console.log('exiting');
});

const rl = readline.createInterface({ input, output });
rl.on('line', (input) => {
  if (input === 'exit') {
    process.exit();
  }
  generate();
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
      console.log(`could not find ${files[0]}, reattempting command`);
    }
    await callback();
    retryCount++;
  } while(!exists(files) && retryCount < 3);
}

function spawnPcbImageProcess() {
  console.log('spawning pcb imager');
  const spawnMessage = 'pcbImageProcess spawned';
  const pcbImageProcess = spawn('docker', [
    'run',
    '-i',
    '-w /board',
    `-v ${__dirname}:/board`,
    '--rm',
    '--entrypoint', '/bin/bash',
    'yaqwsx/kikit:v1.3.0',
    '-c',
    `"echo ${spawnMessage}; /bin/bash"`,
  ], { shell: true });
  const spawnedPromise = new Promise(resolve => {
    const listener = (data) => {
      if (data.includes(spawnMessage)) {
        console.log('spawned pcb imager');
        resolve();
        pcbImageProcess.stdout.off('data', listener);
      }
    };
    pcbImageProcess.stdout.on('data', listener);
  });

  pcbImageProcess.stdout.on('data', (data) => {
    // console.log(`stdout: ${data}`);
  });
  pcbImageProcess.stderr.on('data', (data) => {
    // console.error(`stderr: ${data}`);
  });
  pcbImageProcess.stdin.setEncoding('utf8');
  process.on('exit', () => {
    pcbImageProcess.stdin.end();
  });
  return async (pcbPath) => {
    await spawnedPromise;

    const finishMessage = `done generating ${pcbPath} images`;
    const imagePromise = new Promise(resolve => {
      const listener = (data) => {
        if (data.includes(finishMessage)) {
          resolve();
          pcbImageProcess.stdout.off('data', listener);
        }
      };
      pcbImageProcess.stdout.on('data', listener);
    });
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
}


async function routePcb(pcbImage) {
  await Promise.all([retry(convertKicadPcbToDSN, 'output/pcbs/board.dsn'), fs.mkdir('output/routed_pcbs', { recursive: true })]);
  await freeRouting();
  await retry(reimportAsKicadPcb, 'output/routed_pcbs/board.kicad_pcb');
  await Promise.all([gerbers(), fs.mkdir('output/gerbers', { recursive: true }), pcbImage('routed_pcbs/board')]);
}

async function convertKicadPcbToDSN() {
  const docker = spawn('docker', [
    'run',
    '-w /board',
    `-v ${__dirname}:/board`,
    `-v ${__dirname}\\tmp:/tmp`,
    '--rm',
    'soundmonster/kicad-automation-scripts:latest',
    '/bin/bash', '-c',
    `"${[
      'cp /board/export_dsn.py /usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/export_dsn.py',
      '/usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/export_dsn.py output/pcbs/board.kicad_pcb output/pcbs/board.dsn', // add --record to record a video
    ].join('; ')}"`,
  ], { shell: true });
  docker.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });
  docker.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });
  await once(docker, 'close');
}
// java -jar /opt/freerouting_cli.jar -de $< -do $@
async function freeRouting() {
  const docker = spawn('docker', [
    'run',
    '-w /board',
    `-v ${__dirname}:/board`,
    `-v ${__dirname}\\tmp:/tmp`,
    '--rm',
    'soundmonster/freerouting_cli:v0.1.0',
    'java', '-jar', '/opt/freerouting_cli.jar',
    '-de', 'output/pcbs/board.dsn',
    '-do', 'output/routed_pcbs/board.ses',
  ], { shell: true });
  docker.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });
  docker.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });
  await once(docker, 'close');
}

async function reimportAsKicadPcb() {
  const docker = spawn('docker', [
    'run',
    '-w /board',
    `-v ${__dirname}:/board`,
    `-v ${__dirname}\\tmp:/tmp`,
    '--rm',
    'soundmonster/kicad-automation-scripts:latest',
    '/bin/bash', '-c',
    `"${[
      'cp /board/import_ses.py /usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/import_ses.py',
      '/usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/import_ses.py --record output/pcbs/board.kicad_pcb output/routed_pcbs/board.ses --output-file output/routed_pcbs/board.kicad_pcb', // add --record to record a video
    ].join('; ')}"`,
  ], { shell: true });
  docker.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });
  docker.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });
  await once(docker, 'close');
}

async function gerbers() {
  const docker = spawn('docker', [
    'run',
    '-w /board',
    `-v ${__dirname}:/board`,
    '--rm',
    'yaqwsx/kikit:v1.3.0',
    'fab',
    'jlcpcb',
    '--no-drc',
    '--no-assembly',
    'output/routed_pcbs/board.kicad_pcb',
    'output/gerbers/board'
  ], { shell: true });
  docker.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });
  docker.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });
  await once(docker, 'close');
}
