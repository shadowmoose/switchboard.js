import {TrackerConnector, setLogging} from './matchmaker'


function makeID(length: number) {
    let result           = '';
    let characters       = '0123456789';
    let charactersLength = characters.length;
    for ( let i = 0; i < length; i++ ) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}


// const host = window.location.hash.substr(1) === 'host';

const myID = makeID(20);


setLogging(true);

const conn = new TrackerConnector('ws://localhost:9090', myID, '7EDA978ED7628595BB91C48B947F025BAE78CB77', {});

console.log(conn);

conn.subscribe('peer', (peer) => {
    console.log('Got peer:', peer);
})

conn.subscribe('kill', (err) => {
   if (err) console.error(err);
   console.log('Connection killed.')
});

conn.subscribe('connect', () => {
    console.log('Connected to tracker!');
})
