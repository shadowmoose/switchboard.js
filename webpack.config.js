'use strict';
const path = require('path');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;

module.exports = {
	devtool: 'source-map',
	entry: './src/index.ts',
	target: "web",
	output: {
		filename: 'main.js',
		path: path.resolve(__dirname, 'build')
	},
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				loader: 'ts-loader'
			}
		]
	},
	resolve: {
		extensions: [ '.ts', '.tsx', '.js' ]
	},
	devServer: {
		writeToDisk: true
	},
	node: {
		fs: 'empty'
	},
	plugins: [
		//new BundleAnalyzerPlugin()
	]
};
