// Todo:
//	Extract config info into a module
//		
//	Refactor event data out of main loop, then
//	Handle event data on subscription socket (requires hand-crafted HTTP?)
//	Clean up logging
//	Rationalize REST URLs
//	Reconnect after heartbeat timeout
//	Move to express templates for html pages
//	Keep some stats & build a display page
//	Save state in a JSON file?
//	Event emitters (device state change, variable change)?
//	Learn name of newly discovered variables


var http = 	require('http');
var express = 	require('express');
var fs =	require('fs');
var net =	require('net');
var xml2js =	require('xml2js');
var schedule =	require('node-schedule');
var mqtt = 	require('mqtt');
var logger = 	require('./logger');
var isyconfig = require('./isyconfig');

var mqttClient = false;				// Until we finish integration
console.log('host = ' + isyconfig.host);

var isygettime = "/rest/time";			// Returns current system time
var isyVariableTypes = {1:'Integer', 2:'State'};
var isyControlTypes = {'_0':'Heartbeat',
			'_1':'TriggerEvents',
			'_3':'NodeChanged',
			'_4':'SystemConfig',
			'_5':'SystemStatus',
			'_6':'InternetAccess',
			'_7':'ProgressReport',
			'_8':'SecurityEvent',
			'_9':'AlertEvent',
			'_10':'PowerEvent',
			'_11':'ClimateEvent',
			};
var appStatus = {
	startup: { timestamp: new Date(), description: 'App startup' },
	heartbeat: {description: 'Last heartbeat received' }
	};

var deviceStatus = {};
var devicesByExtname = {};			// Allow lookup by 'external' name
var variableStatus = [[],[],[]];		// [1] - Array of integer variables; [2] - Array of state variables
						//  variableStatus[1][n] =  { name: str, value: nn, updateTime: Date(), init: nn }  // Integervariable 'n's state
var variablesByName = [];			//  variablesByName['varname'] = { type: 1|2, index: n }
var programsById = {};				// As returned from /rest/programs?subfolders=true
var programsByName = {};			// {name1:id1, name2:id2, ...}  with blanks removed from names
var displaySerial = 0;				// Used to mark which elements have changed since last display
var restcalls = 0;				// Count of rest calls
var maxDebugMsgs = 10;

var isyopts = {
	host: isyconfig.host,
	port: 80,
	path: isygettime,
	method: 'GET',
	auth: isyconfig.user + ':' + isyconfig.password,
	}

var latest_response = '';			// 

//logger.debug('ready to check in with isy');

//  Execute a REST command; callback is called with a JSON representation of the response.

var isyREST = function( restQuery, response ) {
    var reqOpts = isyopts;
    reqOpts.path = restQuery;
    restcalls++;
    //logger.debug('isyREST: ' + JSON.stringify(reqOpts));

    if (restcalls <= 100000 ) {

    var isyReq = http.request(reqOpts, function(res) {
        res.setEncoding('utf8');
        var data = '';
        res.on('data', function(d) {
		data += d;			// Accumulate data as it arrives
	});
	res.on('end', function() {		// The entire response is in
	    var parser = new xml2js.Parser({explicitArray:false});
    	    // if (restQuery.match('vars')) logger.debug('REST response for ' + restQuery + ':' + data);
	    parser.parseString(data, function(err, result) {
		response(result);
	    });
	});
    });

    isyReq.on('error', function(e) {
	logger.error('isyREST: ' + e.message);
	logger.error('isyREST request: ' + JSON.stringify(reqOpts));
    });

    isyReq.end();
  }
};

var setISYvariable = function(vn, val, cb) {
	if (typeof variablesByName[vn] != 'undefined') {
		var type = variablesByName[vn].type;
		var id = variablesByName[vn].index;
		logger.debug('setISYvariable: vn=' + vn + ', val=' + val);

		if (vn.match(/^_.*/) != null) {		// Block updates to var starting with '_'
			cb && cb({status: 403, msg: 'Can\'t update ' + vn + ' - write locked'});
		} else {
			isyREST('/rest/vars/set/' + type + '/' + id + '/' + val, function(res){
				// We should look at the response and determine if 200 is really warranted.
				if (!res.RestResponse || !res.RestResponse.status || (res.RestResponse.status != "200")) {
				    logger.debug('setISYvariable: ' + vn + ' response: ' + JSON.stringify(res));
				}
				cb && cb({status: 200, msg: 'Update posted'});
			});
		}
	} else {
		cb && cb({status: 404, msg: 'Variable ' + vn + ' not found'});
	}
};

var getDevDetails = function( devId ) {
    var dev = devId.replace(/ /g, '%20');
    isyREST('/rest/nodes/' + dev, function(devInfo) {
	//logger.debug('devInfo for ' + devId + ': ' + JSON.stringify(devInfo));
        //logger.debug('Name for ' + devId + '(' + devInfo.node.address + ') is ' + devInfo.node.name);
	var nodeparts = devInfo.nodeInfo.node.address.split(" ");	// node is "dd dd dd s" where s is the subdevice
	var noderoot = nodeparts[0] + " " + nodeparts[1] + " " + nodeparts[2];
	var nodesub = nodeparts[3];
	if (maxDebugMsgs-- > 0) console.log(JSON.stringify(devInfo.nodeInfo.node));
	deviceStatus[noderoot][nodesub]['dimmable'] = devInfo.nodeInfo.node.type && (devInfo.nodeInfo.node.type.split('.')[0] == '1');
	deviceStatus[noderoot][nodesub]['name'] = devInfo.nodeInfo.node.name;	// The entry in deviceStatus has always been created
	var extname  = devInfo.nodeInfo.node.name.replace(/[\s\(\)]*/g, "");   	// Used as external device name
	deviceStatus[noderoot][nodesub]['extname'] = extname;   		// Used as external device name
	deviceStatus[noderoot][nodesub]['deviceClass'] = devInfo.nodeInfo.node.deviceClass;	//
	devicesByExtname[extname] = devInfo.nodeInfo.node.address;
    });
};

/* Build a list of program names and IDs */
var buildProgramList = function() {
    var progsByName = {};	// Local copy, start from empty in case a program was deleted or renamed.
    isyREST('/rest/programs?subfolders=true', function( response ) {
	programsById = response;
	//logger.debug(JSON.stringify(programsById));
	// Invert the program list, building an object indexed by name
	// excluding folder names
	for (progNum = 0; progNum < programsById.programs.program.length; progNum++) {
		prog = programsById.programs.program[progNum];
		//logger.debug("Prog: " + JSON.stringify(prog));
		if (prog.$.folder == "true") {
			// Do nothing for folders
		} else {
			var pn = prog.name.replace(/[\s\(\)]*/g, "");
			// logger.debug("Setting id " + prog.$.id + " for "  + prog.name + " as " + pn);
			progsByName[pn] = prog.$.id;
		}
	}
	programsByName = progsByName;		// Replace master list
    });
};

buildProgramList();


// Build a list of variables
var buildVarList = function(type) {
	isyREST('/rest/vars/definitions/' + type, function( response ) {
		var varList = response.CList.e;
		// logger.debug('CList.e:  ' + JSON.stringify(response.CList));
		for (var varNum = 0; varNum < varList.length; varNum++) {
			var varIndex = varList[varNum].$.id;
			var varName = varList[varNum].$.name;
			// logger.debug('Index = ' + varIndex + ', name = ' + varName);
			variablesByName[varName] = {'type':type, 'index':varIndex};
			// logger.debug('for ' + varName + ': ' + JSON.stringify(variablesByName[varName]));
			variableStatus[type][varIndex] = {'name':varName };		// value, updateDate filled in later
		}
		// Now, make another call to get the current and initial values
		isyREST('/rest/vars/get/' + type, function( response ) {
			var varArray = response.vars.var;				// xml is <vars>
											//   <var type="1" id="1">
											//	<init>n</init>
											//	<val>n</val>
											//	<ts>yyyymmdd hh:mm:ss</ts>
											//   </var>
											//   <var></var>...
			for (var varIx = 0; varIx < varArray.length; varIx++) {
				varType = varArray[varIx].$.type;
				varId = varArray[varIx].$.id;
				varVal = varArray[varIx].val;
				varInit = varArray[varIx].init;
				varTs = varArray[varIx].ts;
				if(varVal != undefined)  variableStatus[varType][varId].value = varVal;
				if(varTs != undefined)   variableStatus[varType][varId].updateTime = varTs;
				if(varInit != undefined) variableStatus[varType][varId].init = varInit;
			}
		});
	});
};
buildVarList(1);	// Integer variables
buildVarList(2);	// State variables

// If mqtt configured, set up the client
if (isyconfig.mqttConfig.host) {
	mqttClient = mqtt.createClient(isyconfig.mqttConfig.port, isyconfig.mqttConfig.host);
}

// This is the web server that will allow us to view the state of the system 

var app = express();
logger.debug("Express app is " + JSON.stringify(app));
app.set('view engine', 'jade');
app.set('views', 'templates');
app.use('/media', express.static('./media'));
app.use('/html',  express.static('./html'));

if (process.argv.length > 2) httpListenPort = process.argv[2];		// HACK
else httpListenPort = isyconfig.httpPort;
logger.debug("http listener on " + httpListenPort);
app.listen(httpListenPort);

app.get('/status', function(req, res) {
	var data = '<body>';
	for (key in appStatus) {
		var desc = appStatus[key.description] ? appStatus[key].description : key;
		var ts = appStatus[key].timestamp;
		data += '<p>' + desc + ': ' + ts + '</p>';
	}
	data += '</body>';
	res.send(data);
});

app.get('/', function(req, res) {
	res.render('welcome');
	});

app.get('/devices', function(req, res) {
	var displayDevices = {};
	var highSerial = 0;
	for (key in deviceStatus) {
		displayDevices[key] = {};
		for (subkey in deviceStatus[key]) {
			var stat = deviceStatus[key][subkey].action;
			var label = "On";
			var controls = {};
			var serial = deviceStatus[key][subkey].serial;
			// TODO: Handle edge case where .name does not exist (can occur when device object is just being created)
			var name = deviceStatus[key][subkey].name && ((deviceStatus[key][subkey].name == 'undefined') ? subkey : deviceStatus[key][subkey].name.replace(/.*#/,'')) || '(no name)';
			highSerial = Math.max( serial,  highSerial);
			if (stat > 0) controls['Off'] = '/dev/' + key + ' ' + subkey + '/DOF';
			if (deviceStatus[key][subkey].dimmable) {
				if (stat > 0) controls['Dim'] = '/dev/' + key + ' '  + subkey  + '/DIM';
				if (stat < 255) controls['Bright'] = '/dev/' + key + ' '  + subkey + '/BRT';
			}
			if (stat < 255) controls['On'] = '/dev/' + key + ' '  + subkey + '/DON';
			if (stat == 0) label = "Off";
			if (stat > 0 && stat < 255) label = Math.round((Number(stat)*100)/255) + "%";
			displayDevices[key][subkey] = {name: name, status: label, serial: deviceStatus[key][subkey].serial, controls:controls};
			// if ((displaySerial > 0) && (deviceStatus[key][subkey].serial > displaySerial)) data += "*";
		}
	}
	res.render('devices', {devices:displayDevices});
});

app.get('/dev/:devaddr/:func', function(req, res) {


	var funcMap = {'ON':'DON', 'OFF':'DOF', 'INCREASE':'BRT', 'DECREASE':'DIM', '0':'DOF', '100':'DON'};		//  Map openhab commands to ISY
	var fi  = 0;
	var theCmd;

	func = req.params.func;
	if (typeof funcMap[func] != 'undefined') {
		func = funcMap[func];			// Map from ON to DON, etc.
	} else if ((fi = parseInt(func)) != 'NaN' && fi > 0 && fi <100)  {
		func = Math.round(fi * 2.55);		// Convert from 0-100 to 0-255
		func = 'DON' + '/' + func;			// i.e., DON/127 for 50%
	}

	if (typeof devicesByExtname[req.params.devaddr] != "undefined") {
		theCmd = '/rest/nodes/' + devicesByExtname[req.params.devaddr].replace(/ /g, '%20') + '/cmd/' + func;
	} else {
		theCmd = '/rest/nodes/' + req.params.devaddr.replace(/ /g, '%20') + '/cmd/' + func;
	}
	isyREST( theCmd, function(resp) {
	    res.send(resp);		//  Just return the JSON version of the ISY response
	    if (resp.RestResponse.status != "200") {
		logger.debug("app.get/dev", "request: " + theCmd);
		logger.debug("app.dev/dev", "response:" + JSON.stringify(resp));
	    }
	});
});

// Run program "pn"
// how: 'runIf', 'runThen', 'runElse'
var isyRunProg = function(how, req, res) {
	var pn = req.params.pn;
	logger.debug("Requesting program " + pn );
	if (typeof programsByName[pn] != "undefined") {
		// logger.debug("Calling program " + pn  + ", as ID " + programsByName[pn]);
		isyREST( '/rest/programs/' + programsByName[pn] + '/' + how, function(response) {
			// logger.debug("Ran program id " + programsByName[pn]);
			// logger.debug("Result = " + JSON.stringify(response));
		res.send("Program " + pn + " requested");
		});
	} else {
	logger.debug("Program not found");
	res.status(404).send("Program " + pn + " not found");
	}
};

app.get('/prog/:pn/:how', function(req, res) {
	how = req.params.how;
	if (how == 'runIf' || how == 'runThen' || how == 'runElse') {
		isyRunProg(how, req, res);	
	} else {
		res.status(403).send("Invalid request " + how);
	}
});

// Runs the default "RunIf" mode
app.get('/prog/:pn', function(req,res) {
	isyRunProg('runIf', req, res);
});


app.get('/programs', function(req,res) {
	var data = '';
	for (key in programsByName) {
		data += key + " " + programsByName[key] + "<br />\n";
	}
	res.send(data);
});

app.get('/programs/refresh', function(req,res) {
	buildProgramList();
	var data = '';
	for (key in programsByName) {
		data += key + " " + programsByName[key] + "<br />\n";
	}
	res.send(data);
});

	

app.get('/latest', function(req, res) {
	res.send(latest_response);
	});
app.post('/isyevent', function(req, res) {
	//logger.debug('Got post: ' + req.body);
	});
app.get('/variable/:vn', function(req, res) {
	var vn = req.params.vn;
	var txt = '';
	if (typeof variablesByName[vn] != 'undefined') {
		var type = variablesByName[vn].type;
		var id = variablesByName[vn].index;
		txt = 'Value of ' + vn + ' (type:' + type + ') is ' + variableStatus[type][id].value;
		res.send(txt);
	} else {
		res.status(404).send('Did not find ' + vn);
	}
});
app.get('/variable/:vn/:val', function(req, res) {
	var vn = req.params.vn;
	var val = req.params.val;
	var txt = '';
	if (typeof variablesByName[vn] != 'undefined') {
		var type = variablesByName[vn].type;
		var id = variablesByName[vn].index;
		if (vn.match(/^_.*/) != null) {
			res.status(403).send('Sorry, can\'t update ' + vn);
		} else {
			txt = 'Value of ' + vn + ' is ' + variableStatus[type][id].value + ', setting to ' + val;
			isyREST('/rest/vars/set/' + type + '/' + id + '/' + val, function(res) {});	//  No checking of result for now, but we will get an update event.
			res.send(txt);
		}
	} else {
		res.status(404).send('Did not find ' + vn);
	}
});



app.get('/variables', function(req, res) {
	//logger.info(JSON.stringify(variableStatus[1]));
	var txt = '<table><tr><th>Integer</th><th>Value</th><th>Last</th><th>Init</th></tr>';
	for (var vn = 1, vt=1; vn < variableStatus[vt].length; vn++) {		// Variable indexes start at 1
		if (variableStatus[vt][vn].name  != 'undefined') {
			txt += '<tr><td>' + variableStatus[vt][vn].name + '</td>';
			txt += (variableStatus[vt][vn].value != undefined)      ? '<td>' + variableStatus[vt][vn].value + '</td>' : '<td></td>';
			txt += (variableStatus[vt][vn].updateTime != undefined) ? '<td>' + variableStatus[vt][vn].updateTime + '</td>' : '<td></td>';
			if (variableStatus[vt][vn].init != undefined) txt += '<td>' + variableStatus[vt][vn].init + '</td>';
			txt += '</tr>\n';
		}
	}
	txt += '<tr><th colspan="3">State</th></tr>';
	for (var vn = 1, vt=2; vn < variableStatus[vt].length; vn++) {		// Variable indexes start at 1
		if (variableStatus[vt][vn].name  != 'undefined') {
			txt += '<tr><td>' + variableStatus[vt][vn].name + '</td>';
			txt += (variableStatus[vt][vn].value != undefined)      ? '<td>' + variableStatus[vt][vn].value + '</td>' : '<td></td>';
			txt += (variableStatus[vt][vn].updateTime != undefined) ? '<td>' + variableStatus[vt][vn].updateTime + '</td>' : '<td></td>';
			if (variableStatus[vt][vn].init != undefined) txt += '<td>' + variableStatus[vt][vn].init + '</td>';
			txt += '</tr>\n';
		}
	}
	txt += '</table>';
	res.end(txt);
});

var midnightMaintenance = function() {
	var monthVar = isyconfig.dateFields.month;
	var dayVar = isyconfig.dateFields.day;
	var dt = new Date();

	logger.debug("Running at midnight");
	logger.debug('Month = ' + monthVar);
	logger.debug('Day   = ' + dayVar);
	if (monthVar != '') setISYvariable( monthVar, dt.getMonth()+1, function(status) {});
	if (dayVar != '') setISYvariable( dayVar, dt.getDate(), function(status) {});
}

// If the last heartbeat is too old, issue a warning message.   TODO: attempt reconnect to ISY.
var heartbeatCheck = function() {

}

// Set up a scheduled job to run each day at midnight.   This job will set the month and day of month variables, if defined
var midnightRule = new schedule.RecurrenceRule();
midnightRule.minute = 0;
midnightRule.hour = 0;
var midnightJob = schedule.scheduleJob(midnightRule, midnightMaintenance);

// Schedule a job to run to check for no heartbeat.
var hearbeatCheckJob = schedule.scheduleJob('*/15 * * * *', heartbeatCheck);


// process incoming event data from the ISY
// An incoming connection was received.  Set up a data event handler for this client connection.
var datastr = new String();
var updateSerial = 0;

var processEventData = function(data) {
		// Do some validation of the event notification...
		// TODO: validate
		// info we're looking for: <control>  <action> <node>

		// We're looking for everything from "<?xml" through "</Event>"

		// Add the incoming data to our buffer
		datastr += data.toString();

		// Each section starts with "POST /" and ends with our desired XML

		var xmlregex = /<\?xml.*<\/Event>/;
		var control, node, action;

		while ((section = datastr.indexOf("POST /", 1)) > 0) {
			var datapart = datastr.substr(0,section);
			latest_response = datapart;			// For debug view from web server
			datastr = datastr.substr(section);
			var myxml = xmlregex.exec(datapart);
			var parser = new xml2js.Parser({explicitArray:false});
			parser.on('end', function(result) {
				//logger.debug("Result = " + JSON.stringify(result));
				control = result.Event['control'];
				node = result.Event['node'];
				if (typeof result.Event['node'] == 'string') {
					//logger.debug("typeof node " + typeof result.Event['node']);
					//logger.debug("node: " + node);
					//logger.debug('result=' + JSON.stringify(result));
					var nodeparts = node.split(" ");		// node is "dd dd dd s" where s is the subdevice
					var noderoot = nodeparts[0] + " " + nodeparts[1] + " " + nodeparts[2];
					var nodesub = nodeparts[3];
				}
				action = typeof result.Event['action'] != 'undefined' && result.Event['action'];
				if (control == "_0") {			// Heartbeat
					appStatus.heartbeat.timestamp = new Date();
				} else if (control == "ST") {		// Device status change
					if (typeof(deviceStatus[noderoot]) === 'undefined') {
						deviceStatus[noderoot] = {};
					}
					if (typeof(deviceStatus[noderoot][nodesub]) === 'undefined') {
						deviceStatus[noderoot][nodesub] = {};
						getDevDetails(node);	// First time we've seen this subdevice.  Get its name ...
					}
					deviceStatus[noderoot][nodesub]['action'] = action;
					deviceStatus[noderoot][nodesub]['control'] = control;
					deviceStatus[noderoot][nodesub]['serial'] = updateSerial;

					// Update mqtt if requsted
					if (mqttClient && deviceStatus[noderoot][nodesub]['extname'] != 'undefined') {		//  May not have the name during initialization
						mqttClient.publish( isyconfig.mqttConfig.topic['dev'] + deviceStatus[noderoot][nodesub]['extname'], action);
					}
				} else if (control == "_1") {		// Trigger events
					if (action == "0") {		// program event
						//  The information about the program will be in the eventInfo:
						//The program ID number, note that this is in hex.
						//The status. This is also a hex value that represents a bit field that holds the true/false and idle/run status.
						//	0x20 = true
						//	0x30 = false
						//	0x01 = idle
						//	0x02 = running then section
						//	0x03 = running else section
						//	or program enabled or disabled
						//	timestamp next scheduled run time
						//	timestampl last run time
						//	timestamp last finished run time

						// Not all of these elements will be present in each message. I do see messages without a status element for instance.I think Chris posted a better explanation of the status values a while ago, so you may want to search the forum and see if you can find that. 

					} else if (action == "6") {		// Variable update
						// <eventInfo>
						//	<var id=”<var-id>” type =”<var-type>”>
						//	    <val>value</val>
						//	    <ts>YYYYMDD HH:MM:SS</ts>
						//	</var>
						// </eventInfo>
						var eventInfo = result.Event['eventInfo'];
						// logger.debug('Action 6 eventInfo:', eventInfo);
						var varId = eventInfo.var.$.id;
						var varType = eventInfo.var.$.type;
						var varVal = eventInfo.var.val;
						var varTs = eventInfo.var.ts;
						if (typeof(variableStatus[varType][varId]) === 'undefined') {
							// This variable was unknown - request the list of names again.
							variableStatus[varType][varId] = {};
							buildVarList(varType);
						}
						variableStatus[varType][varId].value = varVal;
						variableStatus[varType][varId].updateTime = varTs;
						// logger.debug('Var status = ' + JSON.stringify(variableStatus[varType][varId]));
						// Update mqtt if requsted
						if (mqttClient) {
							mqttClient.publish( isyconfig.mqttConfig.topic['var'] + variableStatus[varType][varId].name, varVal);
						}
					} else if (action == "7") {	// Variable initialized
						// <eventInfo>
						//	<var id=”<var-id>” type =”<var-type>”>
						//		<init>value</init>
						//	</var>
						// </eventInfo>
						var eventInfo = result.Event['eventInfo'];
						// logger.debug('Action 7 eventInfo:', eventInfo);
						var varId = eventInfo.var.$.id;
						var varType = eventInfo.var.$.type;
						var varInit = eventInfo.var.init;
						if (typeof(variableStatus[varType][varId]) === 'undefined') {
							// This variable was unknown - request the list of names again.
							variableStatus[varType][varId] = {};
							buildVarList(varType);
						}
						variableStatus[varType][varId].init = varInit;
					}
				} else if (control == "_3") {		// Node changed or updated
					// action == "NN" - node renamed <eventInfo><newName>name</newName></eventInfo>
					if (action == "NN") {
						deviceStatus[noderoot][nodesub]['name'] = result.Event.eventInfo.newName;
						var extname = result.Event.eventInfo.newName.replace(/[\s\(\)]*/g, "");   // Used as external device name
						deviceStatus[noderoot][nodesub]['extname'] = extname;   // Used as external device name
						//  Update name lookup table.   Don't bother removing the old entry; both will point to the device until restart.
						devicesByExtname[extname] = devInfo.nodeInfo.node.address;
					}	
				}
				updateSerial++;
			});
			parser.parseString(myxml[0]);
		}

};


// This is the listener that will receive event notifications from the ISY

var eventListener = net.createServer();
eventListener.on('connection', function(client) {
	logger.debug('ISY Connection received');


	client.on('error', function(errorObject) {
		// TCP Error.   Close event will be emitted immediately after error, so log it and wait for next event.
		logger.error('Error in listener on ISY port: ' + JSON.stringify(errorObject));
	});

	client.on('close', function() {
		// ISY closed the connection or an error occurred
		logger.error('ISY client disconnected from server');
	});



	client.on('data', processEventData);

});

eventListener.listen(0, function() {

    console.log('Listening for events on ' + eventListener.address().port);

    var listenPort = eventListener.address().port;

    var isysubscribe = {};
    var subscribeOldMode = false;	// set to true for 3.3.10 or earlier.
    var subscribeBody = '';

    if (subscribeOldMode) {
	subscribeBody = '<s:Envelope><s:Body><u:Subscribe xmlns:u="urn:udicom:service:X_Insteon_Lighting_Service:1"></u:Subscribe></s:Body></sEnvelope>\n';
    } else {
	var reportURL = 'http://' + isyconfig.listenHost + ':' + listenPort + '/';
	logger.debug('reportURL: ' + reportURL);
	subscribeBody = '<s:Envelope><s:Body><u:Subscribe xmlns:u="urn:udicom:service:X_Insteon_Lighting_Service:1">';
	subscribeBody += '<reportURL>' + reportURL  + '</reportURL>';
	subscribeBody += '<duration>infinite</duration></u:Subscribe></s:Body></s:Envelope>';
	logger.debug('body = ' + subscribeBody);
    }
    if (subscribeOldMode) {
	isysubscribe = {
		host: isyconfig.host,
		port: isyconfig.port,
		path: '/eventing',
		method: 'SUBSCRIBE',
		auth: isyconfig.user + ':' + isyconfig.password,
		headers: {'SOAPACTION':  '"urn:udi-com:service:X_Insteon_Lighting_Service:1#Subscribe"',
			'CALLBACK': 'http://' + isyconfig.listenHost + ':' + listenPort + '/',
			'Content-length' : subscribeBody.length,
			'Connection': 'keep-alive'}
		};
    } else {
	isysubscribe = {
		host: isyconfig.host,
		port: isyconfig.port,
		path: '/services',
		method: 'POST',
		auth: isyconfig.user + ':' + isyconfig.password,
		headers: { 'Connection': 'keep-alive'}
		};
    }

	logger.debug("subscribing with " + JSON.stringify(isysubscribe));

  var isysub = http.request(isysubscribe, function(res) {
	logger.debug('STATUS  (subscribe request): ' + res.statusCode);
	logger.debug('HEADERS (subscribe request): ' + JSON.stringify(res.headers));
	res.setEncoding('utf8');
	var data = '';
	res.on('data', function(d) {
		data += d;
	});
	res.on('end', function() {
		logger.debug("received subscription data: " + data);
		midnightMaintenance();		// Make sure dates are sane.
	});
  });

  isysub.write(subscribeBody);
  isysub.end();


});
