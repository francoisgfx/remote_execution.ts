import * as dgram from 'dgram';
import * as net from 'net';
import { resolve } from 'path';
import { setInterval } from 'timers';
import { v1 as uuid } from 'uuid';
import { setFlagsFromString } from 'v8';




//Protocol constants (see PythonScriptRemoteExecution.cpp for the full protocol definition)
const _PROTOCOL_VERSION:number = 1;                                   // Protocol version number
const _PROTOCOL_MAGIC:string = 'ue_py';                               // Protocol magic identifier
const _TYPE_PING:string = 'ping';                                     // Service discovery request (UDP)
const _TYPE_PONG:string = 'pong';                                     // Service discovery response (UDP)
const _TYPE_OPEN_CONNECTION:string = 'open_connection';               // Open a TCP command connection with the requested server (UDP)
const _TYPE_CLOSE_CONNECTION:string = 'close_connection';             // Close any active TCP command connection (UDP)
const _TYPE_COMMAND:string = 'command';                               // Execute a remote Python command (TCP)
const _TYPE_COMMAND_RESULT:string = 'command_result';                 // Result of executing a remote Python command (TCP)

const _NODE_PING_SECONDS:number = 1000;                                  // Number of seconds to wait before sending another "ping" message to discover remote notes
const _NODE_TIMEOUT_SECONDS:number = 5000;                               // Number of seconds to wait before timing out a remote node that was discovered via UDP and has stopped sending "pong" responses

const DEFAULT_MULTICAST_TTL:number = 0;                               // Multicast TTL (0 is limited to the local host, 1 is limited to the local subnet)
const DEFAULT_MULTICAST_GROUP_ENDPOINT:any[] = ['239.0.0.1', 6766];  // The multicast group endpoint tuple that the UDP multicast socket should join (must match the "Multicast Group Endpoint" setting in the Python plugin)
const DEFAULT_MULTICAST_BIND_ADDRESS:string  = '0.0.0.0';              // The adapter address that the UDP multicast socket should bind to, or 0.0.0.0 to bind to all adapters (must match the "Multicast Bind Address" setting in the Python plugin)
const DEFAULT_COMMAND_ENDPOINT:any[] = ['127.0.0.1', 6776];          // The endpoint tuple for the TCP command connection hosted by this client (that the remote client will connect to)

// Execution modes (these must match the names given to LexToString for EPythonCommandExecutionMode in IPythonScriptPlugin.h)
const MODE_EXEC_FILE:string = 'ExecuteFile';                          // Execute the Python command as a file. This allows you to execute either a literal Python script containing multiple statements, or a file with optional arguments
const MODE_EXEC_STATEMENT:string = 'ExecuteStatement';                // Execute the Python command as a single statement. This will execute a single statement and print the result. This mode cannot run files
const MODE_EVAL_STATEMENT:string = 'EvaluateStatement';               // Evaluate the Python command as a single statement. This will evaluate a single statement and return the result. This mode cannot run files

export class RemoteExecutionConfig {
    /*
    Configuration data for establishing a remote connection with a UE4 instance running Python.
    */

    multicast_ttl:number;
    multicast_group_endpoint:any;
    multicast_bind_address:string;
    command_endpoint:any;

    constructor() {
        this.multicast_ttl = DEFAULT_MULTICAST_TTL;
        this.multicast_group_endpoint = DEFAULT_MULTICAST_GROUP_ENDPOINT;
        this.multicast_bind_address = DEFAULT_MULTICAST_BIND_ADDRESS;
        this.command_endpoint = DEFAULT_COMMAND_ENDPOINT;
    }
}

export class RemoteExecution {
    /*
    A remote execution session. This class can discover remote "nodes" (UE4 instances running Python), and allow you to open a command channel to a particular instance.

    Args:
        config (RemoteExecutionConfig): Configuration controlling the connection settings for this session.
    */
    _config:RemoteExecutionConfig;
    _broadcast_connection:_RemoteExecutionBroadcastConnection;
    _command_connection:_RemoteExecutionCommandConnection;
    _node_id:string;

    constructor(config:RemoteExecutionConfig= new RemoteExecutionConfig()) {
        this._config = config;
        this._command_connection = null; //new _RemoteExecutionCommandConnection();
        this._node_id = String(uuid());
        this._broadcast_connection = null; //new _RemoteExecutionBroadcastConnection(this._config, this._node_id);
    }

    get remote_nodes():object[] {
        /*
        Get the current set of discovered remote "nodes" (UE4 instances running Python).

        Returns:
            list: A list of dicts containg the node ID and the other data.
        */
        return this._broadcast_connection ? this._broadcast_connection.remote_nodes : [];
    }

    start(){
        /*
        Start the remote execution session. This will begin the discovey process for remote "nodes" (UE4 instances running Python).
        */
        this._broadcast_connection = new _RemoteExecutionBroadcastConnection(this._config, this._node_id);
        this._broadcast_connection.open();
    }

    stop(){
        /*
        Stop the remote execution session. This will end the discovey process for remote "nodes" (UE4 instances running Python), and close any open command connection.
        */
        this.close_command_connection();
        if (this._broadcast_connection){
            this._broadcast_connection.close();
            this._broadcast_connection = null;
        }
    }

    has_command_connection():boolean {
        /*
        Check whether the remote execution session has an active command connection.

        Returns:
            bool: True if the remote execution session has an active command connection, False otherwise.
        */
        return this._command_connection ? true : false;
    }

    open_command_connection(remote_node_id:string){
        /*
        Open a command connection to the given remote "node" (a UE4 instance running Python), closing any command connection that may currently be open.

        Args:
            remote_node_id (string): The ID of the remote node (this can be obtained by querying `remote_nodes`).
        */
        this._command_connection = new _RemoteExecutionCommandConnection(this._config, this._node_id, remote_node_id);
        this._command_connection.open(this._broadcast_connection);
    }

    close_command_connection(){
        /*
        Close any command connection that may currently be open.
        */
        if (this._command_connection){
            this._command_connection.close(this._broadcast_connection);
            this._command_connection = null;
        }
    }

    run_command(command:string, unattended:boolean=true, exec_mode:string=MODE_EXEC_FILE, raise_on_failure:boolean=false):object {
        /*
        Run a command remotely based on the current command connection.

        Args:
            command (string): The Python command to run remotely.
            unattended (bool): True to run this command in "unattended" mode (suppressing some UI).
            exec_mode (string): The execution mode to use as a string value (must be one of MODE_EXEC_FILE, MODE_EXEC_STATEMENT, or MODE_EVAL_STATEMENT).
            raise_on_failure (bool): True to raise a RuntimeError if the command fails on the remote target.

        Returns:
            dict: The result from running the remote command (see `command_result` from the protocol definition).
        */
        let data = this._command_connection.run_command(command, unattended, exec_mode);
        if (raise_on_failure && !data['success']){
            throw new Error(`Remote Python Command failed! ${data['result']}.`);
        }
        return data
    }

}

class _RemoteExecutionNode {
    /*
    A discovered remote "node" (aka, a UE4 instance running Python).

    Args:
        data (dict): The data representing this node (from its "pong" reponse).
        now (float): The timestamp at which this node was last seen.
    */

    data:object;
    _last_pong:number;

    constructor(data:object, now:number ) {
        this.data = data;
        this._last_pong = _time_now(now);
    }

    should_timeout(now:number):boolean {
        /*
        Check to see whether this remote node should be considered timed-out.

        Args:
            now (float): The current timestamp.

        Returns:
            bool: True of the node has exceeded the timeout limit (`_NODE_TIMEOUT_SECONDS`), False otherwise.
        */
        return (this._last_pong + _NODE_TIMEOUT_SECONDS) < _time_now(now);
    }
}

class _RemoteExecutionBroadcastNodes {
    /*
    A thread-safe set of remote execution "nodes" (UE4 instances running Python).
    */
    _remote_nodes: { [key:string]: any};
    _remote_nodes_lock:any;

    constructor() {
        this._remote_nodes = new Object();
        this._remote_nodes_lock = null;
    }

    get remote_nodes():object[] {
        /*
        Get the current set of discovered remote "nodes" (UE4 instances running Python).

        Returns:
            list: A list of dicts containg the node ID and the other data.
        */
        let remote_nodes_list:object[] = [];
        
        for (let node_id in this._remote_nodes) {
            let node = this._remote_nodes[node_id];
            // Use `key` and `value`
            let remote_node_data: {[key:string]: any} = new Object(node.data); // TODO need to check content of node.data and cast it to dict
            remote_node_data['node_id'] = node_id
            remote_nodes_list.push(remote_node_data)
        }
        return remote_nodes_list
    }

    update_remote_node(node_id:string, node_data:{}, now:number=null){
        /*
        Update a remote node, replacing any existing data.

        Args:
            node_id (str): The ID of the remote node (from its "pong" reponse).
            node_data (dict): The data representing this node (from its "pong" reponse).
            now (float): The timestamp at which this node was last seen.
        */
        const _now:number = _time_now(now);
        if (!this._remote_nodes.hasOwnProperty(node_id)){
            console.log(`Found Node  ${node_id}: ${JSON.stringify(node_data)}`);
        }
        this._remote_nodes[node_id] = new _RemoteExecutionNode(node_data, _now);
    }

    timeout_remote_nodes(now:number){
        /*
        Check to see whether any remote nodes should be considered timed-out, and if so, remove them from this set.

        Args:
            now (float): The current timestamp.
        */
        const _now = _time_now(now);

        for (let node_id in this._remote_nodes) {
            let node = this._remote_nodes[node_id];
            if(node.should_timeout(_now)){
                console.log(`Lost Node ${node_id}: ${node.data}`);
                delete this._remote_nodes[node_id];
            }
        }
    }

}

class _RemoteExecutionBroadcastConnection {
    /*
    A remote execution broadcast connection (for UDP based messaging and node discovery).

    Args:
        config (RemoteExecutionConfig): Configuration controlling the connection settings.
        node_id (string): The ID of the local "node" (this session).
    */
    
    _config:RemoteExecutionConfig;
    _node_id:string;
    _nodes:_RemoteExecutionBroadcastNodes;
    _running:boolean;
    _last_ping:number;
    _broadcast_socket:dgram.Socket;
    _broadcast_listen_thread:any;
    
    constructor(config:RemoteExecutionConfig, node_id:string) {
        this._config = config;
        this._node_id = node_id;
        this._nodes= null; //new _RemoteExecutionBroadcastNodes();
        this._running = false;
        this._broadcast_socket = null; //new Socket();
        this._last_ping = 0;
        this._broadcast_listen_thread = null;
    }

    get remote_nodes():object[] {
        /*
        Get the current set of discovered remote "nodes" (UE4 instances running Python).

        Returns:
            list: A list of dicts containg the node ID and the other data.
        */
        return this._nodes ? this._nodes.remote_nodes : [];
    }

    open(){
        /*
        Open the UDP based messaging and discovery connection. This will begin the discovey process for remote 
        "nodes" (UE4 instances running Python).
        */

        this._running = true;
        this._last_ping = 0;
        this._nodes = new _RemoteExecutionBroadcastNodes();
        this._init_broadcast_socket();        
    }

    close(){
        /*
        Close the UDP based messaging and discovery connection. This will end the discovey process for remote "nodes" (UE4 instances running Python).
        */
        this._running = false;
        if (this._broadcast_socket){
            this._broadcast_socket.close();
            this._broadcast_socket = null;
        }
        this._nodes = null;
        clearInterval(this._broadcast_listen_thread);

    }

    _init_broadcast_socket(){
        /*
        Initialize the UDP based broadcast socket based on the current configuration.
        */
        this._broadcast_socket = dgram.createSocket(
            {
                type: 'udp4',
                reuseAddr: true,
            }
        );
        //this._broadcast_socket.setMulticastLoopback(true);
        //this._broadcast_socket.setMulticastTTL(this._config.multicast_ttl);
        //this._broadcast_socket.setRecvBufferSize(4096);

        this._broadcast_socket.on('listening', () => {
            const address = this._broadcast_socket.address();
            console.log(`server listening ${address.address}:${address.port}`);

            this._broadcast_listen_thread = setInterval(() => {
                const now = _time_now()
                this._broadcast_ping(now)
                this._nodes.timeout_remote_nodes(now)
            },_NODE_PING_SECONDS);  
        });

        this._broadcast_socket.on('message', (data, remote) => {
            //console.log(remote.address + ':' + remote.port +' - ' + data.toString());
            this._handle_data(data);
        });

        this._broadcast_socket.bind(this._config.multicast_group_endpoint[1], this._config.multicast_bind_address, () => {
            console.log("binding is done");
            this._broadcast_socket.addMembership(this._config.multicast_group_endpoint[0],'0.0.0.0');
        });

    }

    /*
    _init_broadcast_listen_thread(){
        Threading is not necessary since everything is async
    }
    _run_broadcast_listen_thread(){
        This is unecessary as the socket is using a callback at init time,
        the ping and timeout check is done with setInterval when the socket open()
    }
    */

    _broadcast_message(message:_RemoteExecutionMessage){
        /*
        Broadcast the given message over the UDP socket to anything that might be listening.

        Args:
            message (_RemoteExecutionMessage): The message to broadcast.
        */
        const data = message.to_json();
        this._broadcast_socket.send(
            data,
            this._config.multicast_group_endpoint[1],
            this._config.multicast_group_endpoint[0]        
        );

    }

    _broadcast_ping(now:number=null){
        /*
        Broadcast a "ping" message over the UDP socket to anything that might be listening.

        Args:
            now (float): The current timestamp.
        */
        const _now = _time_now(now)
        if (!this._last_ping || ((this._last_ping + _NODE_PING_SECONDS) < _now)){
            this._last_ping = _now;
            this._broadcast_message(new _RemoteExecutionMessage(_TYPE_PING, this._node_id));
        }
    }

    broadcast_open_connection(remote_node_id:string){
        /*
        Broadcast an "open_connection" message over the UDP socket to be handled by the specified remote node.

        Args:
            remote_node_id (string): The ID of the remote node that we want to open a command connection with.
        */
        this._broadcast_message(
            new _RemoteExecutionMessage(
                _TYPE_OPEN_CONNECTION, 
                this._node_id, 
                remote_node_id, 
                {
                    'command_ip': this._config.command_endpoint[0],
                    'command_port': this._config.command_endpoint[1],
                }
            )
        );
    }

    broadcast_close_connection(remote_node_id:string){
        /*
        Broadcast a "close_connection" message over the UDP socket to be handled by the specified remote node.

        Args:
            remote_node_id (string): The ID of the remote node that we want to close a command connection with.
        */
        this._broadcast_message(new _RemoteExecutionMessage(_TYPE_CLOSE_CONNECTION, this._node_id, remote_node_id));
    }

    _handle_data(data:Buffer){
        /*
        Handle data received from the UDP broadcast socket.

        Args:
            data (bytes): The raw bytes received from the socket.
        */
        const message = new _RemoteExecutionMessage(null, null);
        if (message.from_json_bytes(data)){
            this._handle_message(message);
        }
    }

    _handle_message(message:_RemoteExecutionMessage){
        /*
        Handle a message received from the UDP broadcast socket.

        Args:
            message (_RemoteExecutionMessage): The message received from the socket.
        */
        if (!message.passes_receive_filter(this._node_id)){
            return;
        }
        if (message.type_ == _TYPE_PONG){
            this._handle_pong_message(message);
            return;
        }
        console.log(`Unhandled remote execution message type ${message.type_}`)
    }

    _handle_pong_message(message:_RemoteExecutionMessage){
        /*
        Handle a "pong" message received from the UDP broadcast socket.

        Args:
            message (_RemoteExecutionMessage): The message received from the socket.
        */
        this._nodes.update_remote_node(message.source, message.data);
    }

}

class _RemoteExecutionCommandConnection {

    _config:RemoteExecutionConfig;
    _node_id:string;
    _remote_node_id:string;
    _command_listen_socket:net.Server;
    _command_channel_socket:net.Socket;
    _nodes:_RemoteExecutionBroadcastNodes;
    _result:_RemoteExecutionMessage;

    constructor(config:RemoteExecutionConfig, node_id:string, remote_node_id:string) {
        this._config = config;
        this._node_id = node_id;
        this._remote_node_id = remote_node_id;
        this._command_listen_socket = null;
        this._command_channel_socket = null;
        this._nodes = null;
        this._result = null;
    }

    open(broadcast_connection:_RemoteExecutionBroadcastConnection){
        /*
        Open the TCP based command connection, and wait to accept the connection from the remote party.

        Args:
            broadcast_connection (_RemoteExecutionBroadcastConnection): The broadcast connection to send UDP based messages over.
        */
        this._nodes = new _RemoteExecutionBroadcastNodes();
        this._init_command_listen_socket();
        this._try_accept(broadcast_connection);
    }

    close(broadcast_connection:_RemoteExecutionBroadcastConnection){
        /*
        Close the TCP based command connection, attempting to notify the remote party.

        Args:
            broadcast_connection (_RemoteExecutionBroadcastConnection): The broadcast connection to send UDP based messages over.
        */
        broadcast_connection.broadcast_close_connection(this._remote_node_id);
        if (this._command_channel_socket){
            this._command_channel_socket.destroy();
            this._command_channel_socket = null;
        }
        if (this._command_listen_socket){
            this._command_listen_socket.close();
            this._command_listen_socket = null;
        }
    }

    run_command(command:string, unattended:boolean, exec_mode:string){
        /*
        Run a command on the remote party.

        Args:
            command (string): The Python command to run remotely.
            unattended (bool): True to run this command in "unattended" mode (suppressing some UI).
            exec_mode (string): The execution mode to use as a string value (must be one of MODE_EXEC_FILE, MODE_EXEC_STATEMENT, or MODE_EVAL_STATEMENT).

        Returns:
            dict: The result from running the remote command (see `command_result` from the protocol definition).
        */
        this._send_message(
            new _RemoteExecutionMessage(
                _TYPE_COMMAND, 
                this._node_id, 
                this._remote_node_id, 
                {
                    'command': command,
                    'unattended': unattended,
                    'exec_mode': exec_mode,
                }
            )
        );
        let result:_RemoteExecutionMessage;
        while (true) {
            // TODO: add timeout here
            if (this._result) {
                result = this._result;
                this._result = null;
                break;
            }
        }
        return result.data;
    }

    _send_message(message:_RemoteExecutionMessage){
        /*
        Send the given message over the TCP socket to the remote party.

        Args:
            message (_RemoteExecutionMessage): The message to send.
        */
        this._command_channel_socket.write(message.to_json());
    }

    _receive_message(data:Buffer, expected_type:string){
        /*
        Receive a message over the TCP socket from the remote party.

        Args:
            expected_type (string): The type of message we expect to receive.

        Returns:
            The message that was received.
        */
       
        //let data = this._command_channel_socket.bytesRead = 4096;
        if(data){
            let message:_RemoteExecutionMessage = new _RemoteExecutionMessage(null, null);
            if(message.from_json_bytes(data) && message.passes_receive_filter(this._node_id) && message.type_ == expected_type){
                return message;
            }
        }
        throw new Error('Remote party failed to send a valid response!');
        

    }

    _init_command_listen_socket(){
        /*
        Initialize the TCP based command socket based on the current configuration, and set it to listen for an incoming connection.
        */
        const host = this._config.command_endpoint[0];
        const port = this._config.command_endpoint[1];

        this._command_listen_socket = net.createServer(); // TCP/IP socket
        this._command_listen_socket.listen(
            {
                port: port,
                host: host,
                backlog: 1,
            }
        )

        this._command_listen_socket.on("connection", (socket) => {
            this._command_channel_socket = socket;
            this._command_channel_socket.on("data", (data) => {
                this._receive_message(data, _TYPE_COMMAND_RESULT);
            });
        });


    }

    _try_accept(broadcast_connection:_RemoteExecutionBroadcastConnection){
        /*
        Wait to accept a connection on the TCP based command connection. This makes 6 attempts to receive a connection, waiting for 5 seconds between each attempt (30 seconds total).

        Args:
            broadcast_connection (_RemoteExecutionBroadcastConnection): The broadcast connection to send UDP based messages over.
        */
        for (let i = 0; i < 6; i++) {
            broadcast_connection.broadcast_open_connection(this._remote_node_id);
            if (this._command_listen_socket){
                return;
            }
        }
        throw new Error('Remote party failed to attempt the command socket connection!');
        
        
    }

}

class _RemoteExecutionMessage {
    /*
    A message sent or received by remote execution (on either the UDP or TCP connection), as UTF-8 encoded JSON.

    Args:
        type_ (string): The type of this message (see the `_TYPE_` constants).
        source (string): The ID of the node that sent this message.
        dest (string): The ID of the destination node of this message, or None to send to all nodes (for UDP broadcast).
        data (dict): The message specific payload data.
    */
    type_:string;
    source:string;
    dest:string;
    data:{};

    constructor(type_:string, source:string, dest:string=null, data:{}=null) {
        this.type_ = type_;
        this.source = source;
        this.dest = dest;
        this.data = data;
    }

    passes_receive_filter(node_id:string){
        /*
        Test to see whether this message should be received by the current node (wasn't sent to itself, and has a compatible destination ID).

        Args:
            node_id (string): The ID of the local "node" (this session).

        Returns:
            bool: True if this message should be received by the current node, False otherwise.
        */
        return this.source != node_id && (!this.dest || this.dest == node_id);
    }

    to_json(){
        /*
        Convert this message to its JSON representation.

        Returns:
            str: The JSON representation of this message.
        */
        if (!this.type_){
            //throw new Error('"type" cannot be empty!');
            console.log('"type" cannot be empty!');
        }
        if (!this.source){
            //throw new Error('"source" cannot be empty!');
            console.log('"source" cannot be empty!');
        }
        let json_obj:{} = {
            'version': _PROTOCOL_VERSION,
            'magic': _PROTOCOL_MAGIC,
            'type': this.type_,
            'source': this.source,
        }
        if (this.dest){
            json_obj['dest'] = this.dest;
        } 
        if (this.data){
            json_obj['data'] = this.data;
        } 
        return JSON.stringify(json_obj);
    }

    to_json_bytes(){
        /*
        Convert this message to its JSON representation as UTF-8 bytes.

        Returns:
            bytes: The JSON representation of this message as UTF-8 bytes.
        */

        // THIS IS NOT NECESSARY IN JS json is already utf8 encoded
        const json_str:string = this.to_json();
        const buffer:Buffer =  Buffer.from(json_str, "utf8");
        return buffer;
    }

    from_json(json_str:string){
        /*
        Parse this message from its JSON representation.

        Args:
            json_str (str): The JSON representation of this message.

        Returns:
            bool: True if this message could be parsed, False otherwise.
        */
       try {
            const json_obj:{} = JSON.parse(json_str);
            // Read and validate required protocol version information
            if (json_obj['version'] != _PROTOCOL_VERSION){
                throw new Error(`"version" is incorrect (got ${json_obj['version']}, expected ${_PROTOCOL_VERSION})!`);
            }
            if (json_obj['magic'] != _PROTOCOL_MAGIC){
                throw new Error(`"magic" is incorrect (got "${json_obj['magic']}", expected "${_PROTOCOL_MAGIC}")!`); 
            }
            // Read required fields
            this.type_ = json_obj['type'];
            this.source = json_obj['source'];
            // Read optional fields
            this.dest = json_obj['dest'];
            this.data = json_obj['data'];
       } catch (error) {
           console.log(`Failed to deserialize JSON "${json_str}": ${error}`);
       }
       return true;

    }

    from_json_bytes(json_bytes:Buffer){
        /*
        Parse this message from its JSON representation as UTF-8 bytes.

        Args:
            json_bytes (bytes): The JSON representation of this message as UTF-8 bytes.

        Returns:
            bool: True if this message could be parsed, False otherwise.
        */
        const json_str:string = json_bytes.toString();
        return this.from_json(json_str);
    }
        


}


function _time_now(now:number=null):number {
    /*
    Utility function to resolve a potentially cached time value.

    Args:
        now (float): The cached timestamp, or None to return the current time.

    Returns:
        float: The cached timestamp (if set), otherwise the current time.
    */
    return now ? now : new Date().getTime()
}

//module.exports = RemoteExecutionConfig;
//module.exports = RemoteExecution;

/*
if (require.main === module){
    let remote_exec = new RemoteExecution();
    remote_exec.start();
    console.log("Enter remote node ID to connect to: ");
    

}
*/

/*
Built-in types
These are the types which are built in TypeScript. They include number, string, boolean, void, null and undefined.
let num: number = 5;  
let isPresent: boolean = true;
User-defined types
The User-defined types include enum, class, interface, array, and tuple. We will discuss some of these later in this article.
*/


/*
function ensureConnection(type: string) {
		let socket;
		let mayahost: string = config.get('hostname');
		let port: string = config.get('mel.port');

		socket = socket_mel;
		port_mel = port;

		if (socket instanceof Socket == true && socket.destroyed == false) {
			Logger.info(`Already active : Port ${port} on Host ${mayahost} for ${type}`);
			updateStatusBarItem(type);
		} else {
			socket = net.createConnection({ port: port, host: mayahost }, () => {
				Logger.info(`Connected : Port ${port} on Host ${mayahost} for ${type}`);
				updateStatusBarItem(type);
			});
			socket.on('error', function(error) {
				let errorMsg = `Unable to connect using port ${port} on Host ${mayahost}   \nPlease run the below mel command in Maya\`s script editor 
				commandPort -n "${mayahost}:${port}" -stp "mel" -echoOutput;
				Error Code : ${error.code}`;
				Logger.error(errorMsg);
				sendError(error, error.code, 'socket')
			});

			socket.on('data', function(data: Buffer) {
				Logger.response(cleanResponse(data));
			});

			socket.on('end', () => {
				Logger.info(`Disconnected from server. ${type} | Port ${port} on Host ${mayahost}`);
				updateStatusBarItem(type);
			});
		}
		return socket;
	}

*/
