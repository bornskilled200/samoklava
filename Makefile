# .DELETE_ON_ERROR:
.SECONDARY:
.PHONY: clean all setup
.DEFAULT: all

container_cmd ?= docker
container_args ?= -w /board -v '$(shell cygpath -w `pwd`):/board' --rm

setup:
	npm install

# outputs from 
output/pcbs/board.kicad_pcb output/pcbs/top_plate.kicad_pcb output/pcbs/bottom_plate.kicad_pcb output/cases/plate_stl.jscad output/cases/case_stl.jscad output/cases/base_stl.jscad &: config.yaml
	npm run gen

output/cases/%.stl: output/cases/%.jscad
	# file can not be present or the script will refuse to run
	mkdir -p $(shell dirname $@)
	npx openjscad $< -o $@

output/pcbs/%.dsn: output/pcbs/%.kicad_pcb
	# file can not be present or the script will refuse to run
	if [ -f "$@" ] ; then rm $@ ; fi
	${container_cmd} run ${container_args} soundmonster/kicad-automation-scripts:latest /bin/bash -c "cp /board/export_dsn.py /usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/export_dsn.py; /usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/export_dsn.py $< $@"

output/pcbs/%-front.png: output/pcbs/%.kicad_pcb
	mkdir -p $(shell dirname $@)
	${container_cmd} run ${container_args} --entrypoint /usr/local/bin/pcbdraw yaqwsx/kikit:v1.3.0 plot --side front --style oshpark-afterdark $< $@

output/pcbs/%-back.png: output/pcbs/%.kicad_pcb
	mkdir -p $(shell dirname $@)
	${container_cmd} run ${container_args} --entrypoint /usr/local/bin/pcbdraw yaqwsx/kikit:v1.3.0 plot --side back --style oshpark-afterdark $< $@

output/routed_pcbs/%.ses: output/pcbs/%.dsn
	mkdir -p $(shell dirname $@)
	${container_cmd} run ${container_args} soundmonster/freerouting_cli:v0.1.0 java -jar /opt/freerouting_cli.jar -de $< -do $@

output/routed_pcbs/%.kicad_pcb: output/routed_pcbs/%.ses output/pcbs/%.kicad_pcb
	mkdir -p $(shell dirname $@)
	# file can not be present or the script will refuse to run
	if [ -f "$@" ] ; then rm $@ ; fi
	${container_cmd} run ${container_args} soundmonster/kicad-automation-scripts:latest /bin/bash -c "cp /board/import_ses.py /usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/import_ses.py; /usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/import_ses.py output/pcbs/$*.kicad_pcb $< --output-file $@"

output/routed_pcbs/%-drc/: output/routed_pcbs/%.kicad_pcb
	mkdir -p $@
	${container_cmd} run ${container_args} soundmonster/kicad-automation-scripts:latest /usr/lib/python2.7/dist-packages/kicad-automation/pcbnew_automation/run_drc.py  $< $@

output/routed_pcbs/%-front.png: output/routed_pcbs/%.kicad_pcb
	mkdir -p $(shell dirname $@)
	${container_cmd} run ${container_args} --entrypoint /usr/local/bin/pcbdraw yaqwsx/kikit:v1.3.0 plot --side front --style oshpark-afterdark $< $@

output/routed_pcbs/%-back.png: output/routed_pcbs/%.kicad_pcb
	mkdir -p $(shell dirname $@)
	${container_cmd} run ${container_args} --entrypoint /usr/local/bin/pcbdraw yaqwsx/kikit:v1.3.0 plot --side back --style oshpark-afterdark $< $@

output/gerbers/%/gerbers.zip: output/routed_pcbs/%.kicad_pcb
	mkdir -p $(shell dirname $@)
	${container_cmd} run ${container_args} yaqwsx/kikit:v1.3.0 fab jlcpcb --no-drc --no-assembly $< $(shell dirname $@)

clean:
	rm -rf output

all: \
	output/gerbers/board/gerbers.zip
# 	output/cases/plate_stl.stl \
# 	output/cases/case_stl.stl \
# 	output/cases/base_stl.stl \
# 	output/pcbs/board-front.png \
# 	output/pcbs/board-back.png \
# 	output/routed_pcbs/board-front.png \
# 	output/routed_pcbs/board-back.png \
# 	output/gerbers/board/gerbers.zip

