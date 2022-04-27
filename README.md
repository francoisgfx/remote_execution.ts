# Unreal Engine remote_execution.ts

Unreal Engine's remote_execution.py (python) port to TypeScript/Javascript (node.js)
This can be used in any javascript app to send python command to Unreal Engine. It was originaly done for a Visual Code Extension. 

NB: the original python code can be found in ref/. This is only as a reference to keep track of the porting. 

## Usage 

```js
import * as remote_execution from './remote_execution'

// find a remote Unreal Engine Node and connect to the first one
if(remote_exec === null){
    remote_exec = new remote_execution.RemoteExecution();
    remote_exec.start();
    const detect_node = setInterval(()=>{
        if(!remote_node_id){
            if(remote_exec.remote_nodes.length > 0){
                remote_node_id = remote_exec.remote_nodes[0]["node_id"];
                console.log("connected to " + remote_node_id)
                remote_exec.open_command_connection(remote_node_id);
            }
        }else{
            clearInterval(detect_node);
        }
    })
}

// Send python command to Unreal Engine
remote_exec.run_command("print('hello')", 'ExecuteFile')

// Close connection with Unreal Engine Node
remote_exec.stop();
remote_exec = null;

```

## Todo
- check inline TODO
- add doc to all class
- convert doc to JSDOC https://code.visualstudio.com/Docs/languages/typescript#_jsdoc-support
- implement logger
