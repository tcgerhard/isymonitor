
// Copy this file to isyconfig.js and edit to match your configuration.

// Config options for isymonitor.js

var isyconfig = {
	host: 'isy',		// Hostname or IP address of the isy 99(4)i controller.
	port: 80,		// Port, normally 80
	user: 'admin',
	password: 'admin',
	listenHost: 'myhost',	// The name or IP of the server isymonitor runs on 

	// ISY variable names for state variables that are updated each day at midnight
	// to the current month and day of the month.    Use '' if the variables are not desired.
	dateFields: { month: 'dtMonthNum', day: 'dtMonthDay' },


	// To publish status updates to mqtt, specify the host and port of the mqtt server
	// The topic will be the string here, plus the device name (with white space removed)
	// If the host is null, no mqtt updates will be attempted
	mqttConfig: { host: '', port: 1883, topic: {dev: '/isy/dev/', 'var':'/isy/var/' }},

	// httpPort -- port for web client
	httpPort: 8000,
};

module.exports = isyconfig;

