/* eslint-disable dot-notation */
import * as dgram from 'dgram'
import * as net from 'net'
import { setInterval } from 'timers'
import { v1 as uuid } from 'uuid'

// Protocol constants (see PythonScriptRemoteExecution.cpp for the full protocol definition)
const _PROTOCOL_VERSION:number = 1 // Protocol version number
const _PROTOCOL_MAGIC:string = 'ue_py' // Protocol magic identifier
const _TYPE_PING:string = 'ping' // Service discovery request (UDP)
const _TYPE_PONG:string = 'pong' // Service discovery response (UDP)
const _TYPE_OPEN_CONNECTION:string = 'open_connection' // Open a TCP command connection with the requested server (UDP)
const _TYPE_CLOSE_CONNECTION:string = 'close_connection' // Close any active TCP command connection (UDP)
const _TYPE_COMMAND:string = 'command' // Execute a remote Python command (TCP)
const _TYPE_COMMAND_RESULT:string = 'command_result' // Result of executing a remote Python command (TCP)

const _NODE_PING_SECONDS:number = 1000 // Number of seconds to wait before sending another "ping" message to discover remote notes
const _NODE_TIMEOUT_SECONDS:number = 5000 // Number of seconds to wait before timing out a remote node that was discovered via UDP and has stopped sending "pong" responses

const DEFAULT_MULTICAST_TTL:number = 0 // Multicast TTL (0 is limited to the local host, 1 is limited to the local subnet)
const DEFAULT_MULTICAST_GROUP_ENDPOINT:any[] = ['239.0.0.1', 6766] // The multicast group endpoint tuple that the UDP multicast socket should join (must match the "Multicast Group Endpoint" setting in the Python plugin)
const DEFAULT_MULTICAST_BIND_ADDRESS:string = '0.0.0.0' // The adapter address that the UDP multicast socket should bind to, or 0.0.0.0 to bind to all adapters (must match the "Multicast Bind Address" setting in the Python plugin)
const DEFAULT_COMMAND_ENDPOINT:any[] = ['127.0.0.1', 6776] // The endpoint tuple for the TCP command connection hosted by this client (that the remote client will connect to)

// Execution modes (these must match the names given to LexToString for EPythonCommandExecutionMode in IPythonScriptPlugin.h)
const MODE_EXEC_FILE:string = 'ExecuteFile' // Execute the Python command as a file. This allows you to execute either a literal Python script containing multiple statements, or a file with optional arguments
// Execute the Python command as a single statement. This will execute a single statement and print the result. This mode cannot run files
const MODE_EXEC_STATEMENT:string = 'ExecuteStatement' // eslint-disable-line
// Evaluate the Python command as a single statement. This will evaluate a single statement and return the result. This mode cannot run files
const MODE_EVAL_STATEMENT:string = 'EvaluateStatement' // eslint-disable-line

export class RemoteExecutionConfig {
  /*
    Configuration data for establishing a remote connection with a UE4 instance running Python.
    */

  multicast_ttl:number
  multicast_group_endpoint:any
  multicast_bind_address:string
  command_endpoint:any

  constructor () {
    this.multicast_ttl = DEFAULT_MULTICAST_TTL
    this.multicast_group_endpoint = DEFAULT_MULTICAST_GROUP_ENDPOINT
    this.multicast_bind_address = DEFAULT_MULTICAST_BIND_ADDRESS
    this.command_endpoint = DEFAULT_COMMAND_ENDPOINT
  }
}

class _RemoteExecutionBroadcastNodes {
  /*
    A thread-safe set of remote execution "nodes" (UE4 instances running Python).
    */
  _remote_nodes: { [key:string]: any}
  _remote_nodes_lock:any

  constructor () {
    this._remote_nodes = {}
    this._remote_nodes_lock = null
  }

  get remote_nodes ():object[] {
    /*
        Get the current set of discovered remote "nodes" (UE4 instances running Python).

        Returns:
            list: A list of dicts containg the node ID and the other data.
        */
    const remoteNodesList:object[] = []

    for (const nodeId in this._remote_nodes) {
      const node = this._remote_nodes[nodeId]
      // Use `key` and `value`
      const remoteNodeData: {[key:string]: any} = new Object(node.data) // eslint-disable-line
      remoteNodeData.nodeId = nodeId
      remoteNodesList.push(remoteNodeData)
    }
    return remoteNodesList
  }

  update_remote_node (nodeId:string, nodeData:{}, now:number = null) {
    /*
        Update a remote node, replacing any existing data.

        Args:
            nodeId (str): The ID of the remote node (from its "pong" reponse).
            nodeData (dict): The data representing this node (from its "pong" reponse).
            now (float): The timestamp at which this node was last seen.
        */
    const _now:number = _timeNow(now)
    if (!Object.prototype.hasOwnProperty.call(this._remote_nodes, nodeId)) {
      console.log(`Found Node  ${nodeId}: ${JSON.stringify(nodeData)}`)
    }
    this._remote_nodes[nodeId] = new _RemoteExecutionNode(nodeData, _now)
  }

  timeout_remote_nodes (now:number) {
    /*
        Check to see whether any remote nodes should be considered timed-out, and if so, remove them from this set.

        Args:
            now (float): The current timestamp.
        */
    const _now = _timeNow(now)

    for (const nodeId in this._remote_nodes) {
      const node = this._remote_nodes[nodeId]
      if (node.should_timeout(_now)) {
        console.log(`Lost Node ${nodeId}: ${node.data}`)
        delete this._remote_nodes[nodeId]
      }
    }
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
  type_:string
  source:string
  dest:string
  data:{}

  constructor (type_:string, source:string, dest:string = null, data:{} = null) {
    this.type_ = type_
    this.source = source
    this.dest = dest
    this.data = data
  }

  passes_receive_filter (nodeId:string) {
    /*
        Test to see whether this message should be received by the current node (wasn't sent to itself, and has a compatible destination ID).

        Args:
            nodeId (string): The ID of the local "node" (this session).

        Returns:
            bool: True if this message should be received by the current node, False otherwise.
        */
    return this.source !== nodeId && (!this.dest || this.dest === nodeId)
  }

  to_json () {
    /*
        Convert this message to its JSON representation.

        Returns:
            str: The JSON representation of this message.
        */
    if (!this.type_) {
      // throw new Error('"type" cannot be empty!');
      console.log('"type" cannot be empty!')
    }
    if (!this.source) {
      // throw new Error('"source" cannot be empty!');
      console.log('"source" cannot be empty!')
    }
    const jsonObj:{} = {
      version: _PROTOCOL_VERSION,
      magic: _PROTOCOL_MAGIC,
      type: this.type_,
      source: this.source
    }
    if (this.dest) {
      // eslint-disable-next-line dot-notation
      jsonObj['dest'] = this.dest
    }
    if (this.data) {
      // eslint-disable-next-line dot-notation
      jsonObj['data'] = this.data
    }
    return JSON.stringify(jsonObj)
  }

  to_jsonBytes () {
    /*
        Convert this message to its JSON representation as UTF-8 bytes.

        Returns:
            bytes: The JSON representation of this message as UTF-8 bytes.
        */

    // THIS IS NOT NECESSARY IN JS json is already utf8 encoded
    const jsonStr:string = this.to_json()
    const buffer:Buffer = Buffer.from(jsonStr, 'utf8')
    return buffer
  }

  from_json (jsonStr:string) {
    /*
        Parse this message from its JSON representation.

        Args:
            jsonStr (str): The JSON representation of this message.

        Returns:
            bool: True if this message could be parsed, False otherwise.
        */
    try {
      const jsonObj:{} = JSON.parse(jsonStr)
      // Read and validate required protocol version information
      if (jsonObj['version'] !== _PROTOCOL_VERSION) {
        throw new Error(`"version" is incorrect (got ${jsonObj['version']}, expected ${_PROTOCOL_VERSION})!`)
      }
      if (jsonObj['magic'] !== _PROTOCOL_MAGIC) {
        throw new Error(`"magic" is incorrect (got "${jsonObj['magic']}", expected "${_PROTOCOL_MAGIC}")!`)
      }
      // Read required fields
      this.type_ = jsonObj['type']
      this.source = jsonObj['source']
      // Read optional fields
      this.dest = jsonObj['dest']
      this.data = jsonObj['data']
    } catch (error) {
      console.log(`Failed to deserialize JSON "${jsonStr}": ${error}`)
    }
    return true
  }

  from_jsonBytes (jsonBytes:Buffer) {
    /*
        Parse this message from its JSON representation as UTF-8 bytes.

        Args:
            jsonBytes (bytes): The JSON representation of this message as UTF-8 bytes.

        Returns:
            bool: True if this message could be parsed, False otherwise.
        */
    const jsonStr:string = jsonBytes.toString()
    return this.from_json(jsonStr)
  }
}

class _RemoteExecutionBroadcastConnection {
  /*
    A remote execution broadcast connection (for UDP based messaging and node discovery).

    Args:
        config (RemoteExecutionConfig): Configuration controlling the connection settings.
        nodeId (string): The ID of the local "node" (this session).
    */

  _config:RemoteExecutionConfig
  _nodeId:string
  _nodes:_RemoteExecutionBroadcastNodes
  _running:boolean
  _last_ping:number
  _broadcast_socket:dgram.Socket
  _broadcast_listen_thread:any

  constructor (config:RemoteExecutionConfig, nodeId:string) {
    this._config = config
    this._nodeId = nodeId
    this._nodes = null // new _RemoteExecutionBroadcastNodes();
    this._running = false
    this._broadcast_socket = null // new Socket();
    this._last_ping = 0
    this._broadcast_listen_thread = null
  }

  get remote_nodes ():object[] {
    /*
        Get the current set of discovered remote "nodes" (UE4 instances running Python).

        Returns:
            list: A list of dicts containg the node ID and the other data.
        */
    return this._nodes ? this._nodes.remote_nodes : []
  }

  open () {
    /*
        Open the UDP based messaging and discovery connection. This will begin the discovey process for remote
        "nodes" (UE4 instances running Python).
        */

    this._running = true
    this._last_ping = 0
    this._nodes = new _RemoteExecutionBroadcastNodes()
    this._init_broadcast_socket()
  }

  close () {
    /*
        Close the UDP based messaging and discovery connection. This will end the discovey process for remote "nodes" (UE4 instances running Python).
        */
    this._running = false
    if (this._broadcast_socket) {
      this._broadcast_socket.close()
      this._broadcast_socket = null
    }
    this._nodes = null
    clearInterval(this._broadcast_listen_thread)
  }

  _init_broadcast_socket () {
    /*
        Initialize the UDP based broadcast socket based on the current configuration.
        */
    this._broadcast_socket = dgram.createSocket(
      {
        type: 'udp4',
        reuseAddr: true
      }
    )
    // this._broadcast_socket.setMulticastLoopback(true);
    // this._broadcast_socket.setMulticastTTL(this._config.multicast_ttl);
    // this._broadcast_socket.setRecvBufferSize(4096);

    this._broadcast_socket.on('listening', () => {
      const address = this._broadcast_socket.address()
      console.log(`Server listening ${address.address}:${address.port}`)

      this._broadcast_listen_thread = setInterval(() => {
        const now = _timeNow()
        this._broadcast_ping(now)
        this._nodes.timeout_remote_nodes(now)
      }, _NODE_PING_SECONDS)
    })

    this._broadcast_socket.on('message', (data, remote) => {
      this._handle_data(data)
    })

    this._broadcast_socket.bind(this._config.multicast_group_endpoint[1], this._config.multicast_bind_address, () => {
      this._broadcast_socket.addMembership(this._config.multicast_group_endpoint[0], '0.0.0.0')
    })
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

  _broadcast_message (message:_RemoteExecutionMessage) {
    /*
        Broadcast the given message over the UDP socket to anything that might be listening.

        Args:
            message (_RemoteExecutionMessage): The message to broadcast.
        */
    const data = message.to_json()
    this._broadcast_socket.send(
      data,
      this._config.multicast_group_endpoint[1],
      this._config.multicast_group_endpoint[0]
    )
  }

  _broadcast_ping (now:number = null) {
    /*
        Broadcast a "ping" message over the UDP socket to anything that might be listening.

        Args:
            now (float): The current timestamp.
        */
    const _now = _timeNow(now)
    if (!this._last_ping || ((this._last_ping + _NODE_PING_SECONDS) < _now)) {
      this._last_ping = _now
      this._broadcast_message(new _RemoteExecutionMessage(_TYPE_PING, this._nodeId))
    }
  }

  broadcast_open_connection (remoteNodeId:string) {
    /*
        Broadcast an "open_connection" message over the UDP socket to be handled by the specified remote node.

        Args:
            remoteNodeId (string): The ID of the remote node that we want to open a command connection with.
        */
    this._broadcast_message(
      new _RemoteExecutionMessage(
        _TYPE_OPEN_CONNECTION,
        this._nodeId,
        remoteNodeId,
        {
          command_ip: this._config.command_endpoint[0],
          command_port: this._config.command_endpoint[1]
        }
      )
    )
  }

  broadcast_close_connection (remoteNodeId:string) {
    /*
        Broadcast a "close_connection" message over the UDP socket to be handled by the specified remote node.

        Args:
            remoteNodeId (string): The ID of the remote node that we want to close a command connection with.
        */
    this._broadcast_message(new _RemoteExecutionMessage(_TYPE_CLOSE_CONNECTION, this._nodeId, remoteNodeId))
  }

  _handle_data (data:Buffer) {
    /*
        Handle data received from the UDP broadcast socket.

        Args:
            data (bytes): The raw bytes received from the socket.
        */
    const message = new _RemoteExecutionMessage(null, null)
    if (message.from_jsonBytes(data)) {
      this._handle_message(message)
    }
  }

  _handle_message (message:_RemoteExecutionMessage) {
    /*
        Handle a message received from the UDP broadcast socket.

        Args:
            message (_RemoteExecutionMessage): The message received from the socket.
        */
    if (!message.passes_receive_filter(this._nodeId)) {
      return
    }
    if (message.type_ === _TYPE_PONG) {
      this._handle_pong_message(message)
      return
    }
    console.log(`Unhandled remote execution message type ${message.type_}`)
  }

  _handle_pong_message (message:_RemoteExecutionMessage) {
    /*
        Handle a "pong" message received from the UDP broadcast socket.

        Args:
            message (_RemoteExecutionMessage): The message received from the socket.
        */
    this._nodes.update_remote_node(message.source, message.data)
  }
}

class _RemoteExecutionCommandConnection {
  _config:RemoteExecutionConfig
  _nodeId:string
  _remoteNodeId:string
  _command_listen_socket:net.Server
  _command_channel_socket:net.Socket
  _nodes:_RemoteExecutionBroadcastNodes
  _result:_RemoteExecutionMessage

  constructor (config:RemoteExecutionConfig, nodeId:string, remoteNodeId:string) {
    this._config = config
    this._nodeId = nodeId
    this._remoteNodeId = remoteNodeId
    this._command_listen_socket = null
    this._command_channel_socket = null
    this._nodes = null
    this._result = null
  }

  open (broadcastConnection:_RemoteExecutionBroadcastConnection) {
    /*
        Open the TCP based command connection, and wait to accept the connection from the remote party.

        Args:
            broadcastConnection (_RemoteExecutionBroadcastConnection): The broadcast connection to send UDP based messages over.
        */
    this._nodes = new _RemoteExecutionBroadcastNodes()
    this._init_command_listen_socket()
    this._try_accept(broadcastConnection)
  }

  close (broadcastConnection:_RemoteExecutionBroadcastConnection) {
    /*
        Close the TCP based command connection, attempting to notify the remote party.

        Args:
            broadcastConnection (_RemoteExecutionBroadcastConnection): The broadcast connection to send UDP based messages over.
        */
    broadcastConnection.broadcast_close_connection(this._remoteNodeId)
    if (this._command_channel_socket) {
      this._command_channel_socket.destroy()
      this._command_channel_socket = null
    }
    if (this._command_listen_socket) {
      this._command_listen_socket.close()
      this._command_listen_socket = null
    }
  }

  run_command (command:string, unattended:boolean, execMode:string, callback?:Function, raiseOnFailure:boolean = false) {
    /*
        Run a command on the remote party.

        Args:
            command (string): The Python command to run remotely.
            unattended (bool): True to run this command in "unattended" mode (suppressing some UI).
            execMode (string): The execution mode to use as a string value (must be one of MODE_EXEC_FILE, MODE_EXEC_STATEMENT, or MODE_EVAL_STATEMENT).
            callback (function): called function when getting response from remote node
            raiseOnFailure (bool): True to raise a RuntimeError if the command fails on the remote target.

        */
    this._send_message(
      new _RemoteExecutionMessage(
        _TYPE_COMMAND,
        this._nodeId,
        this._remoteNodeId,
        {
          command,
          unattended,
          execMode
        }
      )
    )

    // Callback when getting response from remote Node
    this._command_channel_socket.once('data', (data:Buffer) => {
      // parsing the data
      const message = this._receive_message(data, _TYPE_COMMAND_RESULT)
      // raise on failure ?
      if (raiseOnFailure && message.data !== null && !message.data['success']) {
        throw new Error(`Remote Python Command failed! ${message['result']}.`)
      }
      // calling callback
      if (callback && typeof callback === 'function') {
        callback(message.data)
      }
    })
  }

  _send_message (message:_RemoteExecutionMessage) {
    /*
        Send the given message over the TCP socket to the remote party.

        Args:
            message (_RemoteExecutionMessage): The message to send.
        */
    this._command_channel_socket.write(message.to_json())
  }

  _receive_message (data:Buffer, expectedType:string) {
    /*
        Receive a message over the TCP socket from the remote party.

        Args:
            expectedType (string): The type of message we expect to receive.

        Returns:
            The message that was received.
        */

    if (data) {
      const message:_RemoteExecutionMessage = new _RemoteExecutionMessage(null, null)
      if (message.from_jsonBytes(data) && message.passes_receive_filter(this._nodeId) && message.type_ === expectedType) {
        return message
      }
    }
    throw new Error('Remote party failed to send a valid response!')
  }

  _init_command_listen_socket () {
    /*
        Initialize the TCP based command socket based on the current configuration, and set it to listen for an incoming connection.
        */
    const host = this._config.command_endpoint[0]
    const port = this._config.command_endpoint[1]

    this._command_listen_socket = net.createServer() // TCP/IP socket
    this._command_listen_socket.listen(
      {
        port,
        host,
        backlog: 1
      }
    )

    this._command_listen_socket.on('connection', (socket) => {
      this._command_channel_socket = socket
    })
  }

  _try_accept (broadcastConnection:_RemoteExecutionBroadcastConnection) {
    /*
        Wait to accept a connection on the TCP based command connection. This makes 6 attempts to receive a connection, waiting for 5 seconds between each attempt (30 seconds total).

        Args:
            broadcastConnection (_RemoteExecutionBroadcastConnection): The broadcast connection to send UDP based messages over.
        */
    for (let i = 0; i < 6; i++) {
      broadcastConnection.broadcast_open_connection(this._remoteNodeId)
      if (this._command_listen_socket) {
        return
      }
    }
    throw new Error('Remote party failed to attempt the command socket connection!')
  }
}

export class RemoteExecution {
  /*
    A remote execution session. This class can discover remote "nodes" (UE4 instances running Python), and allow you to open a command channel to a particular instance.

    Args:
        config (RemoteExecutionConfig): Configuration controlling the connection settings for this session.
    */
  _config:RemoteExecutionConfig
  _broadcastConnection:_RemoteExecutionBroadcastConnection
  _command_connection:_RemoteExecutionCommandConnection
  _nodeId:string

  constructor (config:RemoteExecutionConfig = new RemoteExecutionConfig()) {
    this._config = config
    this._command_connection = null // new _RemoteExecutionCommandConnection();
    this._nodeId = String(uuid())
    this._broadcastConnection = null // new _RemoteExecutionBroadcastConnection(this._config, this._nodeId);
  }

  get remote_nodes ():object[] {
    /*
        Get the current set of discovered remote "nodes" (UE4 instances running Python).

        Returns:
            list: A list of dicts containg the node ID and the other data.
        */
    return this._broadcastConnection ? this._broadcastConnection.remote_nodes : []
  }

  start () {
    /*
        Start the remote execution session. This will begin the discovey process for remote "nodes" (UE4 instances running Python).
        */
    this._broadcastConnection = new _RemoteExecutionBroadcastConnection(this._config, this._nodeId)
    this._broadcastConnection.open()
  }

  stop () {
    /*
        Stop the remote execution session. This will end the discovey process for remote "nodes" (UE4 instances running Python), and close any open command connection.
        */
    this.close_command_connection()
    if (this._broadcastConnection) {
      this._broadcastConnection.close()
      this._broadcastConnection = null
    }
  }

  has_command_connection ():boolean {
    /*
        Check whether the remote execution session has an active command connection.

        Returns:
            bool: True if the remote execution session has an active command connection, False otherwise.
        */
    return !!this._command_connection
  }

  open_command_connection (remoteNodeId:string) {
    /*
        Open a command connection to the given remote "node" (a UE4 instance running Python), closing any command connection that may currently be open.

        Args:
            remoteNodeId (string): The ID of the remote node (this can be obtained by querying `remote_nodes`).
        */
    this._command_connection = new _RemoteExecutionCommandConnection(this._config, this._nodeId, remoteNodeId)
    this._command_connection.open(this._broadcastConnection)
  }

  close_command_connection () {
    /*
        Close any command connection that may currently be open.
        */
    if (this._command_connection) {
      this._command_connection.close(this._broadcastConnection)
      this._command_connection = null
    }
  }

  run_command (command:string, unattended:boolean = true, execMode:string = MODE_EXEC_FILE, callback?:Function, raiseOnFailure:boolean = false) {
    /*
        Run a command remotely based on the current command connection.

        Args:
            command (string): The Python command to run remotely.
            unattended (bool): True to run this command in "unattended" mode (suppressing some UI).
            execMode (string): The execution mode to use as a string value (must be one of MODE_EXEC_FILE, MODE_EXEC_STATEMENT, or MODE_EVAL_STATEMENT).
            callback (function): called function when getting response from remote node
            raiseOnFailure (bool): True to raise a RuntimeError if the command fails on the remote target.

        */
    this._command_connection.run_command(command, unattended, execMode, callback, raiseOnFailure)
  }
}

class _RemoteExecutionNode {
  /*
    A discovered remote "node" (aka, a UE4 instance running Python).

    Args:
        data (dict): The data representing this node (from its "pong" reponse).
        now (float): The timestamp at which this node was last seen.
    */

  data:object
  _last_pong:number

  constructor (data:object, now:number) {
    this.data = data
    this._last_pong = _timeNow(now)
  }

  should_timeout (now:number):boolean {
    /*
        Check to see whether this remote node should be considered timed-out.

        Args:
            now (float): The current timestamp.

        Returns:
            bool: True of the node has exceeded the timeout limit (`_NODE_TIMEOUT_SECONDS`), False otherwise.
        */
    return (this._last_pong + _NODE_TIMEOUT_SECONDS) < _timeNow(now)
  }
}

function _timeNow (now:number = null):number {
  /*
    Utility function to resolve a potentially cached time value.

    Args:
        now (float): The cached timestamp, or None to return the current time.

    Returns:
        float: The cached timestamp (if set), otherwise the current time.
    */
  return now || new Date().getTime()
}
