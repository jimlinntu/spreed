/* global module */
const initialState = require('@nextcloud/initial-state')
const sdpTransform = require('sdp-transform')

const adapter = require('webrtc-adapter')
const util = require('util')
const webrtcSupport = require('webrtcsupport')
const WildEmitter = require('wildemitter')

function isAllTracksEnded(stream) {
	let isAllTracksEnded = true
	stream.getTracks().forEach(function(t) {
		isAllTracksEnded = t.readyState === 'ended' && isAllTracksEnded
	})
	return isAllTracksEnded
}

function Peer(options) {
	const self = this

	// call emitter constructor
	WildEmitter.call(this)

	this.id = options.id
	this.parent = options.parent
	this.type = options.type || 'video'
	this.oneway = options.oneway || false
	this.sharemyscreen = options.sharemyscreen || false
	this.browserPrefix = options.prefix
	this.stream = options.stream
	this.sendVideoIfAvailable = options.sendVideoIfAvailable === undefined ? true : options.sendVideoIfAvailable
	this.enableDataChannels = options.enableDataChannels === undefined ? this.parent.config.enableDataChannels : options.enableDataChannels
	this.enableSimulcast = options.enableSimulcast === undefined ? this.parent.config.enableSimulcast : options.enableSimulcast
	this.maxBitrates = options.maxBitrates === undefined ? this.parent.config.maxBitrates : options.maxBitrates
	this.receiveMedia = options.receiveMedia || this.parent.config.receiveMedia
	this.channels = {}
	this.pendingDCMessages = [] // key (datachannel label) -> value (array[pending messages])
	this.sid = options.sid || Date.now().toString()
	this.pc = new RTCPeerConnection(this.parent.config.peerConnectionConfig)
	this.pc.addEventListener('icecandidate', this.onIceCandidate.bind(this))
	this.pc.addEventListener('endofcandidates', function(event) {
		self.send('endOfCandidates', event)
	})
	this.pc.addEventListener('addstream', this.handleRemoteStreamAdded.bind(this))
	this.pc.addEventListener('datachannel', this.handleDataChannelAdded.bind(this))
	this.pc.addEventListener('removestream', this.handleStreamRemoved.bind(this))
	// Just fire negotiation needed events for now
	// When browser re-negotiation handling seems to work
	// we can use this as the trigger for starting the offer/answer process
	// automatically. We'll just leave it be for now while this stabalizes.
	this.pc.addEventListener('negotiationneeded', this.emit.bind(this, 'negotiationNeeded'))
	this.pc.addEventListener('iceconnectionstatechange', this.emit.bind(this, 'iceConnectionStateChange'))
	this.pc.addEventListener('iceconnectionstatechange', function() {
		switch (self.pc.iceConnectionState) {
		case 'failed':
			// currently, in chrome only the initiator goes to failed
			// so we need to signal this to the peer
			if (self.pc.localDescription.type === 'offer') {
				self.parent.emit('iceFailed', self)
				self.send('connectivityError')
			}
			break
		}
	})
	this.pc.addEventListener('signalingstatechange', this.emit.bind(this, 'signalingStateChange'))
	this.logger = this.parent.logger

	// handle screensharing/broadcast mode
	if (options.type === 'screen') {
		if (this.parent.localScreen && this.sharemyscreen) {
			this.logger.log('adding local screen stream to peer connection')
			this.pc.addStream(this.parent.localScreen)
			this.broadcaster = options.broadcaster
		}
	} else {
		this.parent.localStreams.forEach(function(stream) {
			stream.getTracks().forEach(function(track) {
				if (track.kind !== 'video' || self.sendVideoIfAvailable) {
					self.pc.addTrack(track, stream)
				}
			})
		})

		this.handleLocalTrackReplacedBound = this.handleLocalTrackReplaced.bind(this)
		// TODO What would happen if the track is replaced while the peer is
		// still negotiating the offer and answer?
		this.parent.on('localTrackReplaced', this.handleLocalTrackReplacedBound)
	}

	// proxy events to parent
	this.on('*', function() {
		self.parent.emit.apply(self.parent, arguments)
	})
}

util.inherits(Peer, WildEmitter)

function shouldPreferH264() {
	try {
		return initialState.loadState('spreed', 'prefer_h264')
	} catch (exception) {
		// If the state can not be loaded an exception is thrown
		console.warn('Could not find initial state for H.264 preference')
		return false
	}
}

function preferH264VideoCodecIfAvailable(sessionDescription) {
	const sdpInfo = sdpTransform.parse(sessionDescription.sdp)

	if (!sdpInfo || !sdpInfo.media) {
		return sessionDescription
	}

	// Find video media
	let videoIndex = -1
	sdpInfo.media.forEach((media, mediaIndex) => {
		if (media.type === 'video') {
			videoIndex = mediaIndex
		}
	})

	if (videoIndex === -1 || !sdpInfo.media[videoIndex].rtp) {
		return sessionDescription
	}

	// Find all H264 codec videos
	const h264Rtps = []
	sdpInfo.media[videoIndex].rtp.forEach((rtp, rtpIndex) => {
		if (rtp.codec.toLowerCase() === 'h264') {
			h264Rtps.push(rtp.payload)
		}
	})

	if (!h264Rtps.length) {
		// No H264 codecs found
		return sessionDescription
	}

	// Sort the H264 codecs to the front in the payload (which defines the preferred order)
	const payloads = sdpInfo.media[videoIndex].payloads.split(' ')
	payloads.sort((a, b) => {
		if (h264Rtps.indexOf(parseInt(a, 10)) !== -1) {
			return -1
		}
		if (h264Rtps.indexOf(parseInt(b, 10)) !== -1) {
			return 1
		}
		return 0
	})

	// Write new payload order into video media payload
	sdpInfo.media[videoIndex].payloads = payloads.join(' ')

	// Write back the sdpInfo into the session description
	sessionDescription.sdp = sdpTransform.write(sdpInfo)

	return sessionDescription
}

// Helper method to munge an SDP to enable simulcasting (Chrome only)
// Taken from janus.js (MIT license).
/* eslint-disable */
function mungeSdpForSimulcasting(sdp) {
	// Let's munge the SDP to add the attributes for enabling simulcasting
	// (based on https://gist.github.com/ggarber/a19b4c33510028b9c657)
	var lines = sdp.split("\r\n");
	var video = false;
	var ssrc = [ -1 ], ssrc_fid = [ -1 ];
	var cname = null, msid = null, mslabel = null, label = null;
	var insertAt = -1;
	for(var i=0; i<lines.length; i++) {
		var mline = lines[i].match(/m=(\w+) */);
		if(mline) {
			var medium = mline[1];
			if(medium === "video") {
				// New video m-line: make sure it's the first one
				if(ssrc[0] < 0) {
					video = true;
				} else {
					// We're done, let's add the new attributes here
					insertAt = i;
					break;
				}
			} else {
				// New non-video m-line: do we have what we were looking for?
				if(ssrc[0] > -1) {
					// We're done, let's add the new attributes here
					insertAt = i;
					break;
				}
			}
			continue;
		}
		if(!video)
			continue;
		var fid = lines[i].match(/a=ssrc-group:FID (\d+) (\d+)/);
		if(fid) {
			ssrc[0] = fid[1];
			ssrc_fid[0] = fid[2];
			lines.splice(i, 1); i--;
			continue;
		}
		if(ssrc[0]) {
			var match = lines[i].match('a=ssrc:' + ssrc[0] + ' cname:(.+)')
			if(match) {
				cname = match[1];
			}
			match = lines[i].match('a=ssrc:' + ssrc[0] + ' msid:(.+)')
			if(match) {
				msid = match[1];
			}
			match = lines[i].match('a=ssrc:' + ssrc[0] + ' mslabel:(.+)')
			if(match) {
				mslabel = match[1];
			}
			match = lines[i].match('a=ssrc:' + ssrc[0] + ' label:(.+)')
			if(match) {
				label = match[1];
			}
			if(lines[i].indexOf('a=ssrc:' + ssrc_fid[0]) === 0) {
				lines.splice(i, 1); i--;
				continue;
			}
			if(lines[i].indexOf('a=ssrc:' + ssrc[0]) === 0) {
				lines.splice(i, 1); i--;
				continue;
			}
		}
		if(lines[i].length == 0) {
			lines.splice(i, 1); i--;
			continue;
		}
	}
	if(ssrc[0] < 0) {
		// Couldn't find a FID attribute, let's just take the first video SSRC we find
		insertAt = -1;
		video = false;
		for(var i=0; i<lines.length; i++) {
			var mline = lines[i].match(/m=(\w+) */);
			if(mline) {
				var medium = mline[1];
				if(medium === "video") {
					// New video m-line: make sure it's the first one
					if(ssrc[0] < 0) {
						video = true;
					} else {
						// We're done, let's add the new attributes here
						insertAt = i;
						break;
					}
				} else {
					// New non-video m-line: do we have what we were looking for?
					if(ssrc[0] > -1) {
						// We're done, let's add the new attributes here
						insertAt = i;
						break;
					}
				}
				continue;
			}
			if(!video)
				continue;
			if(ssrc[0] < 0) {
				var value = lines[i].match(/a=ssrc:(\d+)/);
				if(value) {
					ssrc[0] = value[1];
					lines.splice(i, 1); i--;
					continue;
				}
			} else {
				var match = lines[i].match('a=ssrc:' + ssrc[0] + ' cname:(.+)')
				if(match) {
					cname = match[1];
				}
				match = lines[i].match('a=ssrc:' + ssrc[0] + ' msid:(.+)')
				if(match) {
					msid = match[1];
				}
				match = lines[i].match('a=ssrc:' + ssrc[0] + ' mslabel:(.+)')
				if(match) {
					mslabel = match[1];
				}
				match = lines[i].match('a=ssrc:' + ssrc[0] + ' label:(.+)')
				if(match) {
					label = match[1];
				}
				if(lines[i].indexOf('a=ssrc:' + ssrc_fid[0]) === 0) {
					lines.splice(i, 1); i--;
					continue;
				}
				if(lines[i].indexOf('a=ssrc:' + ssrc[0]) === 0) {
					lines.splice(i, 1); i--;
					continue;
				}
			}
			if(lines[i].length === 0) {
				lines.splice(i, 1); i--;
				continue;
			}
		}
	}
	if(ssrc[0] < 0) {
		// Still nothing, let's just return the SDP we were asked to munge
		console.warn("Couldn't find the video SSRC, simulcasting NOT enabled");
		return sdp;
	}
	if(insertAt < 0) {
		// Append at the end
		insertAt = lines.length;
	}
	// Generate a couple of SSRCs (for retransmissions too)
	// Note: should we check if there are conflicts, here?
	ssrc[1] = Math.floor(Math.random()*0xFFFFFFFF);
	ssrc[2] = Math.floor(Math.random()*0xFFFFFFFF);
	ssrc_fid[1] = Math.floor(Math.random()*0xFFFFFFFF);
	ssrc_fid[2] = Math.floor(Math.random()*0xFFFFFFFF);
	// Add attributes to the SDP
	for(var i=0; i<ssrc.length; i++) {
		if(cname) {
			lines.splice(insertAt, 0, 'a=ssrc:' + ssrc[i] + ' cname:' + cname);
			insertAt++;
		}
		if(msid) {
			lines.splice(insertAt, 0, 'a=ssrc:' + ssrc[i] + ' msid:' + msid);
			insertAt++;
		}
		if(mslabel) {
			lines.splice(insertAt, 0, 'a=ssrc:' + ssrc[i] + ' mslabel:' + mslabel);
			insertAt++;
		}
		if(label) {
			lines.splice(insertAt, 0, 'a=ssrc:' + ssrc[i] + ' label:' + label);
			insertAt++;
		}
		// Add the same info for the retransmission SSRC
		if(cname) {
			lines.splice(insertAt, 0, 'a=ssrc:' + ssrc_fid[i] + ' cname:' + cname);
			insertAt++;
		}
		if(msid) {
			lines.splice(insertAt, 0, 'a=ssrc:' + ssrc_fid[i] + ' msid:' + msid);
			insertAt++;
		}
		if(mslabel) {
			lines.splice(insertAt, 0, 'a=ssrc:' + ssrc_fid[i] + ' mslabel:' + mslabel);
			insertAt++;
		}
		if(label) {
			lines.splice(insertAt, 0, 'a=ssrc:' + ssrc_fid[i] + ' label:' + label);
			insertAt++;
		}
	}
	lines.splice(insertAt, 0, 'a=ssrc-group:FID ' + ssrc[2] + ' ' + ssrc_fid[2]);
	lines.splice(insertAt, 0, 'a=ssrc-group:FID ' + ssrc[1] + ' ' + ssrc_fid[1]);
	lines.splice(insertAt, 0, 'a=ssrc-group:FID ' + ssrc[0] + ' ' + ssrc_fid[0]);
	lines.splice(insertAt, 0, 'a=ssrc-group:SIM ' + ssrc[0] + ' ' + ssrc[1] + ' ' + ssrc[2]);
	sdp = lines.join("\r\n");
	if(!sdp.endsWith("\r\n"))
		sdp += "\r\n";
	return sdp;
}
/* eslint-enable */

Peer.prototype.offer = function(options) {
	const sendVideo = this.sendVideoIfAvailable || this.type === 'screen'
	if (sendVideo && this.enableSimulcast && adapter.browserDetails.browser === 'firefox') {
		console.debug('Enabling Simulcasting for Firefox (RID)')
		const sender = this.pc.getSenders().find(function(s) {
			return s.track.kind === 'video'
		})
		if (sender) {
			let parameters = sender.getParameters()
			if (!parameters) {
				parameters = {}
			}
			parameters.encodings = [
				{
					rid: 'h',
					active: true,
					maxBitrate: this.maxBitrates.high,
				},
				{
					rid: 'm',
					active: true,
					maxBitrate: this.maxBitrates.medium,
					scaleResolutionDownBy: 2,
				},
				{
					rid: 'l',
					active: true,
					maxBitrate: this.maxBitrates.low,
					scaleResolutionDownBy: 4,
				},
			]
			sender.setParameters(parameters)
		}
	}
	this.pc.createOffer(options).then(function(offer) {
		if (shouldPreferH264()) {
			console.debug('Preferring hardware codec H.264 as per global configuration')
			offer = preferH264VideoCodecIfAvailable(offer)
		}

		if (sendVideo && this.enableSimulcast) {
			// This SDP munging only works with Chrome (Safari STP may support it too)
			if (adapter.browserDetails.browser === 'chrome' || adapter.browserDetails.browser === 'safari') {
				console.debug('Enabling Simulcasting for Chrome (SDP munging)')
				offer.sdp = mungeSdpForSimulcasting(offer.sdp)
			} else if (adapter.browserDetails.browser !== 'firefox') {
				console.debug('Simulcast can only be enabled on Chrome or Firefox')
			}
		}

		this.pc.setLocalDescription(offer).then(function() {
			if (this.parent.config.nick) {
				// The offer is a RTCSessionDescription that only serializes
				// its own attributes to JSON, so if extra attributes are needed
				// a regular object has to be sent instead.
				offer = {
					type: offer.type,
					sdp: offer.sdp,
					nick: this.parent.config.nick,
				}
			}
			this.send('offer', offer)
		}.bind(this)).catch(function(error) {
			console.warn('setLocalDescription for offer failed: ', error)
		})
	}.bind(this)).catch(function(error) {
		console.warn('createOffer failed: ', error)
	})
}

Peer.prototype.handleOffer = function(offer) {
	this.pc.setRemoteDescription(offer).then(function() {
		this.answer()
	}.bind(this)).catch(function(error) {
		console.warn('setRemoteDescription for offer failed: ', error)
	})
}

Peer.prototype.answer = function() {
	this.pc.createAnswer().then(function(answer) {
		if (shouldPreferH264()) {
			console.debug('Preferring hardware codec H.264 as per global configuration')
			answer = preferH264VideoCodecIfAvailable(answer)
		}
		this.pc.setLocalDescription(answer).then(function() {
			if (this.parent.config.nick) {
				// The answer is a RTCSessionDescription that only serializes
				// its own attributes to JSON, so if extra attributes are needed
				// a regular object has to be sent instead.
				answer = {
					type: answer.type,
					sdp: answer.sdp,
					nick: this.parent.config.nick,
				}
			}
			this.send('answer', answer)
		}.bind(this)).catch(function(error) {
			console.warn('setLocalDescription for answer failed: ', error)
		})
	}.bind(this)).catch(function(error) {
		console.warn('createAnswer failed: ', error)
	})
}

Peer.prototype.handleAnswer = function(answer) {
	this.pc.setRemoteDescription(answer).catch(function(error) {
		console.warn('setRemoteDescription for answer failed: ', error)
	})
}

Peer.prototype.selectSimulcastStream = function(substream, temporal) {
	if (this.substream === substream && this.temporal === temporal) {
		console.debug('Simulcast stream not changed', this, substream, temporal)
		return
	}

	console.debug('Changing simulcast stream', this, substream, temporal)
	this.send('selectStream', {
		'substream': substream,
		'temporal': temporal,
	})
	this.substream = substream
	this.temporal = temporal
}

Peer.prototype.handleMessage = function(message) {
	const self = this

	this.logger.log('getting', message.type, message)

	if (message.prefix) {
		this.browserPrefix = message.prefix
	}

	if (message.type === 'offer') {
		if (!this.nick) {
			this.nick = message.payload.nick
		}
		delete message.payload.nick
		this.handleOffer(message.payload)
	} else if (message.type === 'answer') {
		if (!this.nick) {
			this.nick = message.payload.nick
		}
		delete message.payload.nick
		this.handleAnswer(message.payload)
	} else if (message.type === 'candidate') {
		this.pc.addIceCandidate(message.payload.candidate)
	} else if (message.type === 'connectivityError') {
		this.parent.emit('connectivityError', self)
	} else if (message.type === 'mute') {
		this.parent.emit('mute', { id: message.from, name: message.payload.name })
	} else if (message.type === 'unmute') {
		this.parent.emit('unmute', { id: message.from, name: message.payload.name })
	} else if (message.type === 'endOfCandidates') {
		this.pc.addIceCandidate('')
	} else if (message.type === 'unshareScreen') {
		this.parent.emit('unshareScreen', { id: message.from })
		this.end()
	} else if (message.type === 'raiseHand') {
		this.parent.emit('raisedHand', { id: message.from, raised: message.payload })
	}
}

// send via signalling channel
Peer.prototype.send = function(messageType, payload) {
	const message = {
		to: this.id,
		sid: this.sid,
		broadcaster: this.broadcaster,
		roomType: this.type,
		type: messageType,
		payload: payload,
		prefix: webrtcSupport.prefix,
	}
	this.logger.log('sending', messageType, message)
	this.parent.emit('message', message)
}

// send via data channel
// returns true when message was sent and false if channel is not open
Peer.prototype.sendDirectly = function(channel, messageType, payload) {
	const message = {
		type: messageType,
		payload: payload,
	}
	this.logger.log('sending via datachannel', channel, messageType, message)
	const dc = this.getDataChannel(channel)
	if (dc.readyState !== 'open') {
		if (!this.pendingDCMessages.hasOwnProperty(channel)) {
			this.pendingDCMessages[channel] = []
		}
		this.pendingDCMessages[channel].push(message)
		return false
	}
	dc.send(JSON.stringify(message))
	return true
}

// Internal method registering handlers for a data channel and emitting events on the peer
Peer.prototype._observeDataChannel = function(channel) {
	const self = this
	channel.onclose = this.emit.bind(this, 'channelClose', channel)
	channel.onerror = this.emit.bind(this, 'channelError', channel)
	channel.onmessage = function(event) {
		self.emit('channelMessage', self, channel.label, JSON.parse(event.data), channel, event)
	}
	channel.onopen = function() {
		self.emit('channelOpen', channel)
		// Check if there are messages that could not be send
		if (self.pendingDCMessages.hasOwnProperty(channel.label)) {
			const pendingMessages = self.pendingDCMessages[channel.label].slice()
			self.pendingDCMessages[channel.label] = []
			for (let i = 0; i < pendingMessages.length; i++) {
				self.sendDirectly(channel.label, pendingMessages[i].type, pendingMessages[i].payload)
			}
		}
	}
}

// Fetch or create a data channel by the given name
Peer.prototype.getDataChannel = function(name, opts) {
	if (!webrtcSupport.supportDataChannel) {
		return this.emit('error', new Error('createDataChannel not supported'))
	}
	let channel = this.channels[name]
	opts || (opts = {})
	if (channel) {
		return channel
	}
	// if we don't have one by this label, create it
	channel = this.channels[name] = this.pc.createDataChannel(name, opts)
	this._observeDataChannel(channel)
	return channel
}

Peer.prototype.onIceCandidate = function(event) {
	const candidate = event.candidate
	if (this.closed) {
		return
	}
	if (candidate) {
		const pcConfig = this.parent.config.peerConnectionConfig
		if (webrtcSupport.prefix === 'moz' && pcConfig && pcConfig.iceTransports
				&& candidate.candidate && candidate.candidate.candidate
				&& candidate.candidate.candidate.indexOf(pcConfig.iceTransports) < 0) {
			this.logger.log('Ignoring ice candidate not matching pcConfig iceTransports type: ', pcConfig.iceTransports)
		} else {
			// Retain legacy data structure for compatibility with
			// mobile clients.
			const expandedCandidate = {
				candidate: {
					candidate: candidate.candidate,
					sdpMid: candidate.sdpMid,
					sdpMLineIndex: candidate.sdpMLineIndex,
				},
			}
			this.send('candidate', expandedCandidate)
		}
	} else {
		this.logger.log('End of candidates.')
	}
}

Peer.prototype.start = function() {
	// well, the webrtc api requires that we either
	// a) create a datachannel a priori
	// b) do a renegotiation later to add the SCTP m-line
	// Let's do (a) first...
	if (this.enableDataChannels) {
		this.getDataChannel('simplewebrtc')
	}

	this.offer(this.receiveMedia)
}

Peer.prototype.icerestart = function() {
	const constraints = this.receiveMedia
	constraints.iceRestart = true
	this.offer(constraints)
}

Peer.prototype.end = function() {
	if (this.closed) {
		return
	}
	this.pc.close()
	this.handleStreamRemoved()
	this.parent.off('localTrackReplaced', this.handleLocalTrackReplacedBound)
}

Peer.prototype.handleLocalTrackReplaced = function(newTrack, oldTrack, stream) {
	let senderFound = false

	this.pc.getSenders().forEach(sender => {
		if (sender.track !== oldTrack) {
			return
		}

		if (!sender.track && !newTrack) {
			return
		}

		if (!sender.kind && sender.track) {
			sender.kind = sender.track.kind
		} else if (!sender.kind) {
			this.pc.getTransceivers().forEach(transceiver => {
				if (transceiver.sender === sender) {
					sender.kind = transceiver.mid
				}
			})
		}

		// A null track can match on audio and video senders, so it needs to be
		// ensured that the sender kind and the new track kind are compatible.
		// However, in some cases it may not be possible to know the sender
		// kind. In those cases just go ahead and try to replace the track; if
		// the kind does not match then replacing the track will fail, but this
		// should not prevent replacing the track with a proper one later, nor
		// affect any other sender.
		if (!sender.track && sender.kind && sender.kind !== newTrack.kind) {
			return
		}

		senderFound = true

		sender.replaceTrack(newTrack).catch(error => {
			if (error.name === 'InvalidModificationError') {
				console.debug('Track could not be replaced, negotiation needed')
			} else {
				console.error('Track could not be replaced: ', error, oldTrack, newTrack)
			}
		})
	})

	// If the call started when the audio or video device was not active there
	// will be no sender for that type. In that case the track needs to be added
	// instead of replaced.
	if (!senderFound && newTrack) {
		this.pc.addTrack(newTrack, stream)
	}
}

Peer.prototype.handleRemoteStreamAdded = function(event) {
	const self = this
	if (this.stream) {
		this.logger.warn('Already have a remote stream')
	} else {
		this.stream = event.stream

		this.stream.getTracks().forEach(function(track) {
			track.addEventListener('ended', function() {
				if (isAllTracksEnded(self.stream)) {
					self.end()
				}
			})
		})

		this.parent.emit('peerStreamAdded', this)
	}
}

Peer.prototype.handleStreamRemoved = function() {
	const peerIndex = this.parent.peers.indexOf(this)
	if (peerIndex > -1) {
		this.parent.peers.splice(peerIndex, 1)
		this.closed = true
		this.parent.emit('peerStreamRemoved', this)
	}
}

Peer.prototype.handleDataChannelAdded = function(event) {
	const channel = event.channel
	this.channels[channel.label] = channel
	this._observeDataChannel(channel)
}

module.exports = Peer
