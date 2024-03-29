# [![switch](https://raw.githubusercontent.com/shadowmoose/switchboard.js/master/examples/Switchboard.js.png)](https://shadowmoose.github.io/switchboard.js)

![Tests](https://github.com/shadowmoose/switchboard.js/workflows/Test%20Package/badge.svg) [![npm](https://img.shields.io/npm/v/switchboard.js) ![npm bundle size](https://img.shields.io/bundlephobia/minzip/switchboard.js?label=bundle%20size)](https://www.npmjs.com/package/switchboard.js) ![Lines of Code](https://raw.githubusercontent.com/shadowmoose/switchboard.js/image-data/loc-badge.svg) [![](https://data.jsdelivr.com/v1/package/npm/switchboard.js/badge)](https://www.jsdelivr.com/package/npm/switchboard.js)

Switchboard.js is a library built to help securely connect users in peer-to-peer networks.
It's specifically designed to work even for developers deploying static sites (say, through [GitHub Pages](https://shadowmoose.github.io/switchboard.js/examples/chat-swarm.html#example))
without an available middleman [signaling](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling)
server to handle peer discovery or authorization.
With Switchboard it's possible to deploy anything from a fully in-browser file server, to a media streaming service,
or even vast online multiplayer applications - all within a single browser tab powered by static HTML.

With switchboard you can establish traditional `client->host` connections, or even connect *full swarms of clients* together.
Switchboard handles all the intricacies involved with reconnection and peer discovery, and uses cryptographic peer IDs to securely connect without the risk of impersonators.
All of this works out of the box in just a few lines of code, and requires zero server setup on the developer's behalf.

## Installation

For developers working with a package manager, ```npm i switchboard.js``` or ```yarn add switchboard.js```.

If you'd prefer a direct bundle for use in a browser script tag, [grab the latest release link from the jsDelivr global CDN](https://www.jsdelivr.com/package/npm/switchboard.js).

For more help, [check out the documentation](https://shadowmoose.github.io/switchboard.js/globals.html).

## Enough talk, give me an example

It's simple to start with Switchboard. Here's a sample that connects to a swarm of clients, and sends them each a greeting:
```ts
import Switchboard from 'switchboard.js';

// Create new matchmaker:
const c = new Switchboard('my-realm-name');  // Realm names keep applications separate

// Connect to a test swarm of Peers - this can be any ID you'd like:
c.swarm('test-swarm');

// Listen for new peer connections as you/they join the swarm:
c.on('peer', (peer) => {
    console.log('Connected to peer:', peer.id, peer);
    peer.send('Hello there!');
    peer.on('data', (data: any) => console.log('Received:', data));
})
// ...and now you have a fully-connected mesh of Peers!
```

...or perhaps you'd like to implement a client->host connection, using persistent IDs that survive through browser restarts?
```ts
import Switchboard from 'switchboard.js';

// Load a secret code from storage, or one will auto-generate if one isn't already saved:
const c = new Switchboard('test-realm', {seed: localStorage['secretSeed']});

// Connect to the host:
c.findHost('Host-ID');

// If we were the host instead:
c.host(); console.log('Connect to me:', c.peerID);

// Listen for the Host or clients - they can be online already, or pop online in the future:
c.on('peer', (peer) => {
    console.log('Connected to a peer:', peer.id, peer);
    peer.send('Hello there, buddy!');
    peer.on('data', (data: any) => console.log('Received from peer:', data));
})

localStorage['secretSeed'] = c.secretSeed; // Store this identity for use later on reload.
// The browser will now reuse the same identity whenever it reloads!
```
You can see the code is pretty much the same either way, thanks to the simple API.
For more examples - such as creating and destroying media streams live, as you need them - see [the examples directory, deployed to github-pages](https://shadowmoose.github.io/switchboard.js/examples/index.html).
There are also many more advanced ways to customize the behavior of Switchboard, including hooking events and authorization,
and you can [read more about those here](https://shadowmoose.github.io/switchboard.js/globals.html)

## Okay, so how's it work?
Switchboard is lightweight, small, simple, and extremely fast.
This was accomplished by writing the WebRTC code completely from scratch, instead of relying on existing libraries.
Skipping the usual bloated WebRTC libraries in favor of direct API access has several major advantages:

+ __Fewer Dependencies:__ Because it sits right on top of the built-in browser WebRTC API, we can avoid the giant dependency stacks the more common libraries come with.
+ __Bundling and Types:__ Rewriting the common stuff in TypeScript gets us full tree-shaking for a minimal bundle size, easy reference for the API, and [great documentation.](https://shadowmoose.github.io/switchboard.js/globals.html)
+ __Faster:__ Switchboard manages its own connections and authentication, so it can establish and validate incoming connections much faster - typically before the connection is even fully established!

## So there aren't any servers involved?
Well... no. Unfortunately, that's impossible in the current world of WebRTC. However - there are so many public resources available these days, that a developer need not roll their own matchmaking server!

Switchboard makes use of decentralized, public, battle-tested peering systems that exist online. Rather than relying on a single always-on server that the developer would have to set up, maintain, and secure - Switchboard piggybacks off the existing tracker infrastructure used web-wide by systems like WebTorrent. Switchboard will automatically connect to every tracker it is told about, to be sure it has multiple redundant fallbacks. 

Having multiple public trackers at its disposal makes Switchboard far more reliable than most services can hope to achieve. You can simply use the default list of public trackers, or provide your own. Built-in custom logic deals with these servers for you - and Switchboard won't fail unless none of the provided servers can be reached. Is one tracker offline or unreachable in a region? No problem - Switchboard will handle the disconnection, retries, and finding Peers via the other available trackers, all without requiring user intervention.

If you have the resources and don't want to use public servers, it is trivial to spin up [your own private server](https://github.com/shadowmoose/switchboard.js/wiki/The-Switchboard-Peering-Server). However, you don't need to worry about security when using public servers either. Switchboard uses public key encryption on top of a simple cryptographic ID fingerprint system for every single connection. Wherever you are, whatever you use, whenever you connect to somebody, you will always know they're exactly who they say they are.

To use the built-in Switchboard Peering Server that you can self-host, simply provide the connection details as Tracker Configs, like so:

```js
const sb = new switchboard.Switchboard('TestRealm', {
    trackers: [
        {
            uri: 'ws://localhost:8080',
            isNativeServer: true,
            passCode: '[PASSCODE SET ON SERVER, OR NULL]'
        }
    ]
});
```

Check out [the Project Wiki](https://github.com/shadowmoose/switchboard.js/wiki/The-Switchboard-Peering-Server) for more information about setup.
