import { Worker } from 'node:worker_threads';
import { shutdownResources } from '../../src/shutdown.js';

const scenario=process.argv[2];
const store={releaseLease(){console.log('lease released');},close(){console.log('store closed');}};
const client={async destroy(){console.log('discord closed');}};
let code=0,timeoutMs=1000;
if(scenario==='db-error') {
  code=1;const worker=new Worker('setInterval(()=>{},1000)',{eval:true});
  store.releaseLease=()=>{throw new Error('DB disconnected');};
  store.close=()=>{console.log('store closed');void worker.terminate();};
} else if(scenario==='discord-error') {
  code=1;client.destroy=async()=>{throw new Error('network');};
} else if(scenario==='hung-handles') {
  timeoutMs=40;setInterval(()=>{},1000);
  client.destroy=()=>new Promise(()=>{});
  store.releaseLease=()=>{throw new Error('DB disconnected');};
  store.close=()=>{console.log('close attempted');throw new Error('worker unavailable');};
} else if(scenario!=='normal')throw new Error('Unknown shutdown test scenario');
await shutdownResources({client,store,code,timeoutMs});
