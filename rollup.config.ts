import json from "rollup-plugin-json";
import typescript from "rollup-plugin-typescript2";
import commonjs from "rollup-plugin-commonjs";
import resolve from "rollup-plugin-node-resolve";
import uglify from "@lopatnov/rollup-plugin-uglify";
import nodePolyfills from 'rollup-plugin-node-polyfills';

import pkg from './package.json';

export default [
  {
    // Build minified pre-made version for the Browser, including all polyfills for Node-specific libraries:
    input: `src/${pkg.buildEntryPoint}.ts`,
    output: {
      file: `dist/${pkg.buildEntryPoint}-browser.min.js`,
      name: pkg.umdName,
      format: "umd",
      sourcemap: true
    },
    external: [
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {})
    ],
    plugins: [
      json(),
      typescript({
        typescript: require("typescript"),
        tsconfigOverride: {
          compilerOptions: {
            "module": "es2015"  // Required for rollup to work properly.
          }
        },
      }),
      resolve({ preferBuiltins: true }),
      commonjs(),
      nodePolyfills({ include: ['buffer']}),
      uglify()
    ]
  }
];
