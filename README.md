[![switch](https://i.imgur.com/oK9kwVl.png)](https://shadowmoose.github.io/switchboard.js)
# switchboard.js [![Build Docs](https://github.com/shadowmoose/switchboard.js/workflows/Build%20Docs/badge.svg)](https://shadowmoose.github.io/switchboard.js)

__This is a Work in Progress. It may not even be functional currently.__

Switchboard.js is a library built to help connect users in peer-to-peer networks. It's specifically designed to work even for developers deploying static sites (say, through [GitHub Pages](https://shadowmoose.github.io/switchboard.js/examples/chat-swarm.html)) without an available middleman ([signaling](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling)) server to handle peer discovery. With Switchboard it's possible to deploy anything from a fully in-browser file server, to a media streaming service, or even vast online multiplayer applications - all within a single browser tab powered by static HTML.

With switchboard you can establish traditional `client->host` connections, or even connect *full swarms of clients* together. Switchboard handles all the intricacies involved with reconnection and peer discovery, and uses cryptographic peer IDs to securely connect without the risk of impersonators. All of this works out of the box in just a few lines of code, and requires zero server setup on the developer's behalf.

## Enough talk, give me an example:

It's simple to start with Switchboard. Here's a sample that connects to a swarm of clients, and sends them each a greeting:
```ts
import Switchboard from 'switchboard.js';

// Create new matchmaker:
const c = new Switchboard();

// Connect to a test swarm of Peers - this can be any ID you'd like:
c.swarm('test-swarm');

// Listen for new peer connections as you/they join the swarm:
c.subscribe('peer', (peer) => {
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
const c = new Switchboard({seed: localStorage.getItem('secretSeed')});

// Connect to the host:
c.findHost('Host-ID');

// If we were the host instead:
// c.host();

// Listen for the Host - they can be online already, or pop online in the future:
c.subscribe('peer', (peer) => {
    console.log('Connected to the Host:', peer.id, peer);
    peer.send('Hello there, Mr. Host!');
    peer.on('data', (data: any) => console.log('Received from host:', data));
})

localStorage.setItem('secretSeed', c.secretSeed); // Store this identity for use later on reload.
// The browser will now reuse the same identity whenever it reloads!
```
You can see the code is pretty much the same either way, thanks to the simple API.
For more examples, see [the examples directory, deployed to github-pages](https://shadowmoose.github.io/switchboard.js/examples/).
There are also many more advanced ways to customize the behavior of Switchboard, including hooking events and authorization,
and you can [read more about those here](https://shadowmoose.github.io/switchboard.js)

## Okay, so how's it work?
Switchboard is lightweight, small, simple, and blazingly-fast.
This was accomplished by completely rewriting the tracker-handling code, instead of relying on existing libraries.
Skipping the usual bloated WebRTC libraries in favor of direct API access has several major advantages:

+ __Smaller Bundle Size:__ While it works with all WebRTC implementations, Switchboard doesn't import any of the usual bloated WebRTC libraries!
+ __TypeScript:__ Rewriting the common stuff in TypeScript gets us full tree-shaking, easy reference for the API, and [great documentation.](https://shadowmoose.github.io/switchboard.js)
+ __Lower-Level:__ Switchboard also gets faster access to do fancy things - such as rejecting unwanted Peers before they can even establish a connection.

## So there aren't any servers involved?
Well... no. Unfortunately, that's impossible in the current world of WebRTC. However - there are so many public resources available these days, that a developer need not roll their own matchmaking server!

Switchboard makes use of multiple public, reliable WebTorrent peering servers that exist online. You can simply use the default list built-in, or provide your own.
Switchboard will connect to them all to be sure it has multiple redundant fallbacks. Having multiple public services at its disposal makes Switchboard far more reliable than most services can hope to achieve.
Built-in custom logic deals with these servers for you, and Switchboard won't fail unless none of the provided servers can be reached.

If you have the resources and don't want to use public servers, it is trivial to spin up [your own private server](https://github.com/webtorrent/bittorrent-tracker). However, you don't need to worry about using public servers either. Switchboard uses public key encryption on top of a simple ID system for every single connection. Wherever you are, whenever you connect to somebody, you will always know they're exactly who they say they are.
