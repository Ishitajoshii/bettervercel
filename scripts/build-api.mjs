import { build } from 'esbuild';

await build({ entryPoints: ['api/aws.mjs'], outfile: '.build/control-api/index.js', bundle: true,
  platform: 'node', target: 'node24', format: 'cjs', minify: true, sourcemap: false });
console.log('Built control API with pinned AWS SDK dependencies.');
