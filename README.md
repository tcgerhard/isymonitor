isymonitor
==========

node.js app to provide alternate REST interface to UDI's ISY99(4)i Home Automation controller

This app is very rough, lots of work still to do.

Installation:

1.  git clone https://github.com/tcgerhard/isymonitor.git
2.  npm install
3.  copy isyconfig-install.js to isyconfig.js
4. edit isyconfig.js to include the hostname or IP address of your isy and change the credentials as needed

There is a very basic http listener on the port configured via isyconfig.httpPort.   It supports the following:

* /status -- provides a brief status message indicating startup time and last heartbeat received from the isy
* /programs -- a barely formatted list of programs, using the naming format supported by other http commands
* /devices -- displays a crude listing of known devices and their states, along with basic controls to control the device
* /dev/i\<dev addr\>/\<func\> -- control a device where
  * \<dev addr\> is formatted like "12 34 BC 1" 
  * \<func\> is an ISY function: DON, DOF, DIM, BRT
* /prog/\<pn\>/how -- run a program.  how = runIf, runThen, runElse
* /prog/\<pn\> -- run a program (including conditions), where
  * \<pn\> is the program name, as formatted in the result from /programs
* /programs/refresh -- requests a rebuild of the program list from the isy.  Needed because the isy does not send an event when a program is added or renamed.
* /variables -- returns a list of variables and associated state information
* /variable/\<vn\> -- returns the value of variable named <vn>
* /variable/\<vn\>/\<newval\> -- updates the value of a variable, where
  * \<vn\> is the variable name
  * \<newval\> is the new value for the variable

Notes:
* Currently, isymonitor creates a TCP port and listens on that port for event data from the isy.   This requires that the ISY be able to open a TCP connection to isymonitor, which may require firewall rule changes.   At this version, you cannot specify the port for this connection; it is dynamically selected.





