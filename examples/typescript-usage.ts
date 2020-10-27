// Simple demo for importing and using Switchboard via TypeScript.
import * as sb from '../';


const b = new sb.Switchboard({
    clientTimeout: 1000
});


b.on('peer', peer => {
    console.log("Peer connected:", peer.id);
    peer.send('hello!');
    peer.on('data', data => {
        console.log('Read:', data);
    })
})

b.swarm('test-swarm-id');
