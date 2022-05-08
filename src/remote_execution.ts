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

/**
 * Configuration data for establishing a remote connection with a UE4 instance running Python.
 */
export class RemoteExecutionConfig {
  multicastTTL:number
  multicastGroupEndpoint:any
  multicastBindAddress:string
  commandEndpoint:any

  /**
   * The construction of the RemoteExecutionConfig class
   *
   * @param {number} multicastTTL Multicast TTL (0 is limited to the local host, 1 is limited to the local subnet)
   * @param {any[]} multicastGroupEndpoint The multicast group endpoint tuple that the UDP multicast socket should join (must match the "Multicast Group Endpoint" setting in the Python plugin)
   * @param {string} multicastBindAddress The adapter address that the UDP multicast socket should bind to, or 0.0.0.0 to bind to all adapters (must match the "Multicast Bind Address" setting in the Python plugin)
   * @param {any[]} commandEndpoint The endpoint tuple for the TCP command connection hosted by this client (that the remote client will connect to)
   */
  constructor (multicastTTL:number = DEFAULT_MULTICAST_TTL, multicastGroupEndpoint:any[] = DEFAULT_MULTICAST_GROUP_ENDPOINT, multicastBindAddress:string = DEFAULT_MULTICAST_BIND_ADDRESS, commandEndpoint:any[] = DEFAULT_COMMAND_ENDPOINT) {
    this.multicastTTL = multicastTTL
    this.multicastGroupEndpoint = multicastGroupEndpoint
    this.multicastBindAddress = multicastBindAddress
    this.commandEndpoint = commandEndpoint
  }
}

/**
 * A thread-safe set of remote execution "nodes" (UE4 instances running Python).
 */
class _RemoteExecutionBroadcastNodes {
  _remote_nodes: { [key:string]: any}
  _remote_nodes_lock:any

  /**
   * The constructor for the _RemoteExecutionBroadcastNodes class
   *
   */
  constructor () {
    this._remote_nodes = {}
    this._remote_nodes_lock = null
  }

  /**
   * Get the current set of discovered remote "nodes" (UE4 instances running Python).
   *
   * @returns {object[]} A list of dicts containg the node ID and the other data.
   */
  get remote_nodes (): object[] {
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

  /**
   * Update a remote node, replacing any existing data.
   *
   * @param {string} nodeId The ID of the remote node (from its "pong" reponse).
   * @param {object} nodeData The data representing this node (from its "pong" reponse).
   * @param {number} now The timestamp at which this node was last seen.
   */
  update_remote_node (nodeId:string, nodeData:{}, now:number = null): void {
    const _now:number = _timeNow(now)
    if (!Object.prototype.hasOwnProperty.call(this._remote_nodes, nodeId)) {
      console.log(`Found Node  ${nodeId}: ${JSON.stringify(nodeData)}`)
    }
    this._remote_nodes[nodeId] = new _RemoteExecutionNode(nodeData, _now)
  }

  /**
   * Check to see whether any remote nodes should be considered timed-out, and if so, remove them from this set.
   *
   * @param {number} now The current timestamp.
   */
  timeout_remote_nodes (now:number): void {
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

/**
 * A message sent or received by remote execution (on either the UDP or TCP connection), as UTF-8 encoded JSON.
 */
class _RemoteExecutionMessage {
  type_:string
  source:string
  dest:string
  data:{}

  /**
   * The constructor for the _RemoteExecutionMessage class
   *
   * @param {string} type_ The type of this message (see the `_TYPE_` constants).
   * @param {string} source The ID of the node that sent this message.
   * @param {string} dest The ID of the destination node of this message, or None to send to all nodes (for UDP broadcast).
   * @param {object} data The message specific payload data.
   */
  constructor (type_:string, source:string, dest:string = null, data:{} = null) {
    this.type_ = type_
    this.source = source
    this.dest = dest
    this.data = data
  }

  /**
   * Test to see whether this message should be received by the current node (wasn't sent to itself, and has a compatible destination ID).
   *
   * @param {string} nodeId The ID of the local "node" (this session).
   * @returns {boolean} true if this message should be received by the current node, false otherwise.
   */
  passes_receive_filter (nodeId:string): boolean {
    return this.source !== nodeId && (!this.dest || this.dest === nodeId)
  }

  /**
   * Convert this message to its JSON representation.
   *
   * @returns {string} The JSON representation of this message.
   */
  to_json (): string {
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

  /**
   * Convert this message to its JSON representation as UTF-8 bytes.
   *
   * @returns {Buffer} The JSON representation of this message as UTF-8 bytes.
   */
  to_jsonBytes (): Buffer {
    // THIS IS NOT NECESSARY IN JS json is already utf8 encoded
    const jsonStr:string = this.to_json()
    const buffer:Buffer = Buffer.from(jsonStr, 'utf8')
    return buffer
  }

  /**
   * Parse this message from its JSON representation.
   *
   * @param {string} jsonStr The JSON representation of this message.
   * @returns {boolean} true if this message could be parsed, false otherwise.
   */
  from_json (jsonStr:string): boolean {
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

  /**
   * Parse this message from its JSON representation as UTF-8 bytes.
   *
   * @param {Buffer} jsonBytes The JSON representation of this message as UTF-8 bytes.
   * @returns {boolean} true if this message could be parsed, false otherwise.
   */
  from_jsonBytes (jsonBytes:Buffer): boolean {
    const jsonStr:string = jsonBytes.toString()
    return this.from_json(jsonStr)
  }
}

/**
 * A remote execution broadcast connection (for UDP based messaging and node discovery).
 */
class _RemoteExecutionBroadcastConnection {
  _config:RemoteExecutionConfig
  _nodeId:string
  _nodes:_RemoteExecutionBroadcastNodes
  _running:boolean
  _last_ping:number
  _broadcast_socket:dgram.Socket
  _broadcast_listen_thread:any

  /**
   * The constructor for the _RemoteExecutionBroadcastConnection class
   *
   * @param {RemoteExecutionConfig} config Configuration controlling the connection settings.
   * @param {string} nodeId The ID of the local "node" (this session).
   */
  constructor (config:RemoteExecutionConfig, nodeId:string) {
    this._config = config
    this._nodeId = nodeId
    this._nodes = null // new _RemoteExecutionBroadcastNodes();
    this._running = false
    this._broadcast_socket = null // new Socket();
    this._last_ping = 0
    this._broadcast_listen_thread = null
  }

  /**
   * Get the current set of discovered remote "nodes" (UE4 instances running Python).
   *
   * @returns {object[]} A list of object containg the node ID and the other data.
   */
  get remote_nodes ():object[] {
    return this._nodes ? this._nodes.remote_nodes : []
  }

  /**
   * Open the UDP based messaging and discovery connection. This will begin the discovey process
   * for remote "nodes" (UE4 instances running Python).
   */
  open (): void {
    this._running = true
    this._last_ping = 0
    this._nodes = new _RemoteExecutionBroadcastNodes()
    this._init_broadcast_socket()
  }

  /**
   * Close the UDP based messaging and discovery connection. This will end the discovey process for remote "nodes" (UE4 instances running Python).
   */
  close (): void {
    this._running = false
    if (this._broadcast_socket) {
      this._broadcast_socket.close()
      this._broadcast_socket = null
    }
    this._nodes = null
    clearInterval(this._broadcast_listen_thread)
  }

  /**
   * Initialize the UDP based broadcast socket based on the current configuration.
   */
  _init_broadcast_socket (): void {
    this._broadcast_socket = dgram.createSocket(
      {
        type: 'udp4',
        reuseAddr: true
      }
    )

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

    this._broadcast_socket.bind(this._config.multicastGroupEndpoint[1], this._config.multicastBindAddress, () => {
      this._broadcast_socket.addMembership(this._config.multicastGroupEndpoint[0], '0.0.0.0')
    })
  }

  /**
   * Broadcast the given message over the UDP socket to anything that might be listening.
   *
   * @param {_RemoteExecutionMessage} message The message to broadcast.
   */
  _broadcast_message (message:_RemoteExecutionMessage): void {
    const data = message.to_json()
    this._broadcast_socket.send(
      data,
      this._config.multicastGroupEndpoint[1],
      this._config.multicastGroupEndpoint[0]
    )
  }

  /**
   * Broadcast a "ping" message over the UDP socket to anything that might be listening.
   *
   * @param {number} now The current timestamp.
   */
  _broadcast_ping (now:number = null): void {
    const _now = _timeNow(now)
    if (!this._last_ping || ((this._last_ping + _NODE_PING_SECONDS) < _now)) {
      this._last_ping = _now
      this._broadcast_message(new _RemoteExecutionMessage(_TYPE_PING, this._nodeId))
    }
  }

  /**
   * Broadcast an "open_connection" message over the UDP socket to be handled by the specified remote node.
   *
   * @param {string} remoteNodeId The ID of the remote node that we want to open a command connection with.
   */
  broadcast_open_connection (remoteNodeId:string): void {
    this._broadcast_message(
      new _RemoteExecutionMessage(
        _TYPE_OPEN_CONNECTION,
        this._nodeId,
        remoteNodeId,
        {
          command_ip: this._config.commandEndpoint[0],
          command_port: this._config.commandEndpoint[1]
        }
      )
    )
  }

  /**
   * Broadcast a "close_connection" message over the UDP socket to be handled by the specified remote node.
   *
   * @param {string} remoteNodeId The ID of the remote node that we want to close a command connection with.
   */
  broadcast_close_connection (remoteNodeId:string): void {
    this._broadcast_message(new _RemoteExecutionMessage(_TYPE_CLOSE_CONNECTION, this._nodeId, remoteNodeId))
  }

  /**
   * Handle data received from the UDP broadcast socket.
   *
   * @param {Buffer} data The raw bytes received from the socket.
   */
  _handle_data (data:Buffer): void {
    const message = new _RemoteExecutionMessage(null, null)
    if (message.from_jsonBytes(data)) {
      this._handle_message(message)
    }
  }

  /**
   * Handle a message received from the UDP broadcast socket.
   *
   * @param {_RemoteExecutionMessage} message The message received from the socket.
   */
  _handle_message (message:_RemoteExecutionMessage): void {
    if (!message.passes_receive_filter(this._nodeId)) {
      return
    }
    if (message.type_ === _TYPE_PONG) {
      this._handle_pong_message(message)
      return
    }
    console.log(`Unhandled remote execution message type ${message.type_}`)
  }

  /**
   * Handle a "pong" message received from the UDP broadcast socket.
   *
   * @param {_RemoteExecutionMessage} message The message received from the socket.
   */
  _handle_pong_message (message:_RemoteExecutionMessage): void {
    this._nodes.update_remote_node(message.source, message.data)
  }
}

/**
 * A remote execution command connection (for TCP based command processing).
 */
class _RemoteExecutionCommandConnection {
  _config:RemoteExecutionConfig
  _nodeId:string
  _remoteNodeId:string
  _command_listen_socket:net.Server
  _command_channel_socket:net.Socket
  _nodes:_RemoteExecutionBroadcastNodes
  _result:_RemoteExecutionMessage

  /**
   * The constructor for the _RemoteExecutionCommandConnection class
   *
   * @param {RemoteExecutionConfig} config Configuration controlling the connection settings.
   * @param {string} nodeId The ID of the local "node" (this session).
   * @param {string} remoteNodeId The ID of the remote "node" (the UE4 instance running Python).
   */
  constructor (config:RemoteExecutionConfig, nodeId:string, remoteNodeId:string) {
    this._config = config
    this._nodeId = nodeId
    this._remoteNodeId = remoteNodeId
    this._command_listen_socket = null
    this._command_channel_socket = null
    this._nodes = null
    this._result = null
  }

  /**
   * Open the TCP based command connection, and wait to accept the connection from the remote party.
   *
   * @param {_RemoteExecutionBroadcastConnection} broadcastConnection The broadcast connection to send UDP based messages over.
   */
  open (broadcastConnection:_RemoteExecutionBroadcastConnection): void {
    this._nodes = new _RemoteExecutionBroadcastNodes()
    this._init_command_listen_socket()
    this._try_accept(broadcastConnection)
  }

  /**
   * Close the TCP based command connection, attempting to notify the remote party.
   *
   * @param {_RemoteExecutionBroadcastConnection} broadcastConnection The broadcast connection to send UDP based messages over.
   */
  close (broadcastConnection:_RemoteExecutionBroadcastConnection): void {
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

  /**
   * Run a command on the remote party.
   *
   * @param {string} command The Python command to run remotely.
   * @param {boolean} unattended true to run this command in "unattended" mode (suppressing some UI).
   * @param {string} execMode The execution mode to use as a string value (must be one of MODE_EXEC_FILE, MODE_EXEC_STATEMENT, or MODE_EVAL_STATEMENT).
   * @param {Function} callback Called function when getting response from remote node
   * @param {boolean} raiseOnFailure true to throw an Error if the command fails on the remote target.
   */
  run_command (command:string, unattended:boolean, execMode:string, callback?:Function, raiseOnFailure:boolean = false): void {
    this._send_message(
      new _RemoteExecutionMessage(
        _TYPE_COMMAND,
        this._nodeId,
        this._remoteNodeId,
        {
          'command': command,
          'unattended': unattended,
          'exec_mode': execMode
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

  /**
   * Send the given message over the TCP socket to the remote party.
   *
   * @param {_RemoteExecutionMessage} message The message to send.
   */
  _send_message (message:_RemoteExecutionMessage) {
    this._command_channel_socket.write(message.to_json())
  }

  /**
   * Receive a message over the TCP socket from the remote party.
   *
   * @param {Buffer} data recieved message from remote node
   * @param {string} expectedType The type of message we expect to receive.
   * @returns {_RemoteExecutionMessage} The parsed message that was received.
   */
  _receive_message (data:Buffer, expectedType:string): _RemoteExecutionMessage {
    if (data) {
      const message:_RemoteExecutionMessage = new _RemoteExecutionMessage(null, null)
      if (message.from_jsonBytes(data) && message.passes_receive_filter(this._nodeId) && message.type_ === expectedType) {
        return message
      }
    }
    throw new Error('Remote party failed to send a valid response!')
  }

  /**
   * Initialize the TCP based command socket based on the current configuration, and set it to listen for an incoming connection.
   */
  _init_command_listen_socket (): void {
    const host = this._config.commandEndpoint[0]
    const port = this._config.commandEndpoint[1]

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

  /**
   * Wait to accept a connection on the TCP based command connection. This makes 6 attempts to receive a connection, waiting for 5 seconds between each attempt (30 seconds total).
   *
   * @param {_RemoteExecutionBroadcastConnection} broadcastConnection The broadcast connection to send UDP based messages over.
   */
  _try_accept (broadcastConnection:_RemoteExecutionBroadcastConnection): void {
    for (let i = 0; i < 6; i++) {
      broadcastConnection.broadcast_open_connection(this._remoteNodeId)
      if (this._command_listen_socket) {
        return
      }
    }
    throw new Error('Remote party failed to attempt the command socket connection!')
  }
}

/**
 * A remote execution session. This class can discover remote "nodes" (UE4 instances running Python), and allow you to open a command channel to a particular instance.
 */
export class RemoteExecution {
  _config:RemoteExecutionConfig
  _broadcastConnection:_RemoteExecutionBroadcastConnection
  _command_connection:_RemoteExecutionCommandConnection
  _nodeId:string

  /**
   * The constructor for the RemoteExecution class
   *
   * @param {RemoteExecutionConfig} config Configuration controlling the connection settings for this session.
   */
  constructor (config:RemoteExecutionConfig = new RemoteExecutionConfig()) {
    this._config = config
    this._command_connection = null
    this._nodeId = String(uuid())
    this._broadcastConnection = null
  }

  /**
   * Get the current set of discovered remote "nodes" (UE4 instances running Python).
   *
   * @returns {object[]} A list of object containg the node ID and the other data.
   */
  get remote_nodes (): object[] {
    return this._broadcastConnection ? this._broadcastConnection.remote_nodes : []
  }

  /**
   * Start the remote execution session. This will begin the discovey process for remote "nodes" (UE4 instances running Python).
   */
  start () {
    this._broadcastConnection = new _RemoteExecutionBroadcastConnection(this._config, this._nodeId)
    this._broadcastConnection.open()
  }

  /**
   * Stop the remote execution session. This will end the discovey process for remote "nodes" (UE4 instances running Python), and close any open command connection.
   */
  stop () {
    this.close_command_connection()
    if (this._broadcastConnection) {
      this._broadcastConnection.close()
      this._broadcastConnection = null
    }
  }

  /**
   * Check whether the remote execution session has an active command connection.
   *
   * @returns {boolean} true if the remote execution session has an active command connection, false otherwise.
   */
  has_command_connection (): boolean {
    return !!this._command_connection
  }

  /**
   * Open a command connection to the given remote "node" (a UE4 instance running Python), closing any command connection that may currently be open.
   *
   * @param {string} remoteNodeId The ID of the remote node (this can be obtained by querying `remote_nodes`).
   */
  open_command_connection (remoteNodeId:string): void {
    this._command_connection = new _RemoteExecutionCommandConnection(this._config, this._nodeId, remoteNodeId)
    this._command_connection.open(this._broadcastConnection)
  }

  /**
   * Close any command connection that may currently be open.
   */
  close_command_connection (): void {
    if (this._command_connection) {
      this._command_connection.close(this._broadcastConnection)
      this._command_connection = null
    }
  }

  /**
   * Run a command remotely based on the current command connection.
   *
   * @param {string} command The Python command to run remotely.
   * @param {boolean} unattended true to run this command in "unattended" mode (suppressing some UI).
   * @param {string} execMode The execution mode to use as a string value (must be one of MODE_EXEC_FILE, MODE_EXEC_STATEMENT, or MODE_EVAL_STATEMENT).
   * @param {Function} callback called function when getting response from remote node
   * @param {boolean} raiseOnFailure true to raise a RuntimeError if the command fails on the remote target
   */
  run_command (command:string, unattended:boolean = true, execMode:string = MODE_EXEC_FILE, callback?:Function, raiseOnFailure:boolean = false) {
    this._command_connection.run_command(command, unattended, execMode, callback, raiseOnFailure)
  }
}

/**
 * A discovered remote "node" (aka, a UE4 instance running Python).
 */
class _RemoteExecutionNode {
  data:object
  _last_pong:number

  /**
   * The constructor for the _RemoteExecutionNode class
   *
   * @param {object} data The data representing this node (from its "pong" reponse).
   * @param {number} now The timestamp at which this node was last seen.
   */
  constructor (data:object, now:number) {
    this.data = data
    this._last_pong = _timeNow(now)
  }

  /**
   * Check to see whether this remote node should be considered timed-out.
   *
   * @param {number} now The current timestamp.
   * @returns {boolean} true of the node has exceeded the timeout limit (`_NODE_TIMEOUT_SECONDS`), false otherwise.
   */
  should_timeout (now:number): boolean {
    return (this._last_pong + _NODE_TIMEOUT_SECONDS) < _timeNow(now)
  }
}

/**
 * Utility function to resolve a potentially cached time value.
 *
 * @param {number} now The cached timestamp, or None to return the current time.
 * @returns {number} The cached timestamp (if set), otherwise the current time.
 */
function _timeNow (now:number = null): number {
  return now || new Date().getTime()
}
