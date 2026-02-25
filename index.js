#!/usr/bin/env node
const { program } = require('commander');
const path = require('path');
const fs = require('fs');
const { parseRoutes } = require('./src/parser');
const { drawMap } = require('./src/mapDrawer');

program
  .requiredOption('-i, --input <dir>', 'Input directory containing route files (.gpx, .fit, .tcx)')
  .requiredOption('-o, --output <file>', 'Output PNG file path (e.g. result.png)')
  .option('-w, --width <number>', 'Width of the image', (val) => parseInt(val, 10), 1920)
  .option('-h, --height <number>', 'Height of the image', (val) => parseInt(val, 10), 1440)
  .option('-c, --color <string>', 'Line color in RGB (e.g. 0,0,255 for blue)', '0,0,255')
  .option('-a, --alpha <number>', 'Line opacity (0.0 to 1.0)', parseFloat, 0.8)
  .option('-s, --style <string>', 'Map style (osm, dark, light)', 'osm')
  .option('-b, --bbox', 'Use bounding box of all routes (default)', true)
  .option('-B, --no-bbox', 'Render whole world map instead of bounding box')
  .option('-j, --japan', 'Render only Japan area', false)
  .parse(process.argv);

const options = program.opts();

async function main() {
  console.log(`===============================================`);
  console.log(` ActivityPlotter / Map Drawer`);
  console.log(`===============================================`);
  console.log(`Input dir : ${options.input}`);
  console.log(`Output file: ${options.output}`);
  console.log(`Image Size : ${options.width}x${options.height}`);
  console.log(`Map Style  : ${options.style}`);
  console.log(`Use BBox  : ${options.bbox}`);
  console.log(`Use Japan : ${options.japan}`);
  console.log(`Line Color : rgb(${options.color})`);
  console.log(`Line Alpha : ${options.alpha}`);
  console.log(`===============================================`);

  const inputDir = path.resolve(process.cwd(), options.input);
  if (!fs.existsSync(inputDir)) {
    console.error(`[Error] Input directory '${inputDir}' does not exist.`);
    process.exit(1);
  }

  // 1. 指定ディレクトリから各ファイルをパースして座標配列を取得
  console.log('\n[1/2] Parsing route files...');
  const routes = await parseRoutes(inputDir);

  if (routes.length === 0) {
    console.error('[Error] No valid routes (with coordinate points) found.');
    process.exit(1);
  }
  console.log(`Successfully parsed ${routes.length} valid route(s).`);

  // 2. 地図の生成と描画
  console.log('\n[2/2] Drawing Map & Routes...');
  await drawMap(routes, options);

  console.log(`\n[Success] Done! Output saved to ${options.output}`);
}

main().catch(err => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
