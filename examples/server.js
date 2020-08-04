/*
	This is a simple webtorrent tracker WebSocket server, for local testing.
 */
const port = 9090;
const hostname = 'localhost';

let Server = require('bittorrent-tracker').Server

let server = new Server({
	udp: false, // enable udp server? [default=true]
	http: false, // enable http server? [default=true]
	ws: true, // enable websocket server? [default=true]
	stats: true, // enable web-based statistics? [default=true]
	filter: function (infoHash, params, cb) {
		cb(null)
	}
})

server.on('error', function (err) {
	// fatal server error!
	console.log('Server Error:', err.message)
})

server.on('warning', function (err) {
	// client sent bad data. probably not a problem, just a buggy client.
	console.log('Server Warning:', err.message)
})

server.on('listening', function () {
	// fired when all requested servers are listening
	console.log('listening on http port:' + server.http.address().port)
	// console.log('listening on udp port:' + server.udp.address().port)
})

// start tracker server listening! Use 0 to listen on a random free port.
server.listen(port, hostname, () => {
	console.log("Server listening!")
})

// listen for individual tracker messages from peers:

server.on('start', function (addr) {
	console.log('got start message from ' + addr)
})

server.on('complete', function (addr) {})
server.on('update', function (addr) {})
server.on('stop', function (addr) {})
