import json from "rollup-plugin-json";
import typescript from "rollup-plugin-typescript2";
import commonjs from "rollup-plugin-commonjs";
import resolve from "rollup-plugin-node-resolve";
import uglify from "@lopatnov/rollup-plugin-uglify";
import nodePolyfills from 'rollup-plugin-node-polyfills';

import pkg from './package.json';

export default [
  {
    // Build output formats for importing as a library in projects with their own build chain:
    input: `src/${pkg.buildEntryPoint}.ts`,
    output: [
      { // NodeJS (or generic) Package format, for standard import:
        file: pkg.main,
        format: "umd",
        name: pkg.umdName,
        sourcemap: true
      },
      { // Newer, cleaner export (ESM) for bundlers that support ES6.
        file: pkg.module,
        format: "es",
        sourcemap: true
      }
    ],
    external: [
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {})
    ],
    plugins: [
      json(),
      typescript({
        typescript: require("typescript")
      }),
      resolve({ preferBuiltins: true }),
      commonjs(),
      nodePolyfills(),
    ]
  },
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
        typescript: require("typescript")
      }),
      resolve({ preferBuiltins: true }),
      commonjs(),
      nodePolyfills({ include: ['buffer']}),
      uglify()
    ]
  }
];
