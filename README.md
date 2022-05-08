# Unreal Engine remote_execution.ts

Unreal Engine's remote_execution.py (python) port to TypeScript/Javascript (node.js)

This can be used in any javascript app to send python command to Unreal Engine. It was originaly done for a Visual Code Extension [vscode-to-unreal](https://github.com/francoisgfx/vscode-to-unreal). 

The port is very similar to the python version except for the async/threaded part. Yet it should be easy to maintain. 
(Original remote_execution.py can be find in your Unreal Engine Install ie: C:\Program Files\Epic Games\UE_5.0\Engine\Plugins\Experimental\PythonScriptPlugin\Content\Python)

NB: the original python code can be found in ref/. This is only as a reference to keep track of the porting. 

## Usage 

```js
import * as remote_execution from './remote_execution'

// find a remote Unreal Engine Node and connect to the first one
if(remoteExec === null){
    remoteExec = new remote_execution.RemoteExecution();
    remoteExec.start();
    const detectNode = setInterval(()=>{
        if(!remoteNodeId){
            if(remoteExec.remote_nodes.length > 0){
                remoteNodeId = remoteExec.remoteNodes[0]["node_id"];
                console.log("connected to " + remoteNodeId)
                remoteExec.open_command_connection(remoteNodeId);
            }
        }else{
            clearInterval(detectNode);
        }
    })
}

// Send python command to Unreal Engine
remoteExec.run_command("print('hello')", 'ExecuteFile', (data)=>{
    console.log("Response:", data);
})

// Close connection with Unreal Engine Node
remoteExec.stop();
remoteExec = null;

```

## Todo
- implement logger
