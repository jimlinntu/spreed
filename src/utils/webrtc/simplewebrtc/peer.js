/* global module */
const initialState = require('@nextcloud/initial-state')
const sdpTransform = require('sdp-transform')

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
	this.stream = options.stream
	this.sendVideoIfAvailable = options.sendVideoIfAvailable === undefined ? true : options.sendVideoIfAvailable
	this.enableDataChannels = options.enableDataChannels === undefined ? this.parent.config.enableDataChannels : options.enableDataChannels
	this.receiveMedia = options.receiveMedia || this.parent.config.receiveMedia
	this.channels = {}
	this.pendingDCMessages = [] // key (datachannel label) -> value (array[pending messages])
	this._pendingReplaceTracksQueue = []
	this._processPendingReplaceTracksPromise = null
	this._initialStreamSetup = false
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
		if (!options.receiverOnly && self.pc.iceConnectionState !== 'new') {
			self._processPendingReplaceTracks().then(finished => {
				if (finished === false || self._initialStreamSetup) {
					return
				}

				// Ensure that initially disabled tracks are stopped after
				// establishing a connection.
				self.pc.getSenders().forEach(sender => {
					if (sender.track) {
						// The stream is not known, but it is only used when the
						// track is added, so it can be ignored here.
						self.handleLocalTrackEnabledChanged(sender.track, null)
					}
				})

				self._initialStreamSetup = true
			})
		} else {
			self._initialStreamSetup = false
		}

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

	if (!options.receiverOnly) {
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

			this.handleLocalTrackEnabledChangedBound = this.handleLocalTrackEnabledChanged.bind(this)
			this.parent.on('localTrackEnabledChanged', this.handleLocalTrackEnabledChangedBound)
		}
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

Peer.prototype.offer = function(options) {
	this.pc.createOffer(options).then(function(offer) {
		if (shouldPreferH264()) {
			console.debug('Preferring hardware codec H.264 as per global configuration')
			offer = preferH264VideoCodecIfAvailable(offer)
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

Peer.prototype.handleMessage = function(message) {
	const self = this

	this.logger.log('getting', message.type, message)

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
		payload,
	}
	this.logger.log('sending', messageType, message)
	this.parent.emit('message', message)
}

// send via data channel
// returns true when message was sent and false if channel is not open
Peer.prototype.sendDirectly = function(channel, messageType, payload) {
	const message = {
		type: messageType,
		payload,
	}
	this.logger.log('sending via datachannel', channel, messageType, message)
	const dc = this.getDataChannel(channel)
	if (dc.readyState !== 'open') {
		if (!Object.prototype.hasOwnProperty.call(this.pendingDCMessages, channel)) {
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
		if (Object.prototype.hasOwnProperty.call(self.pendingDCMessages, channel.label)) {
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
	this.parent.off('localTrackEnabledChanged', this.handleLocalTrackEnabledChangedBound)
}

Peer.prototype.handleLocalTrackReplaced = function(newTrack, oldTrack, stream) {
	this._pendingReplaceTracksQueue.push({ newTrack, oldTrack, stream })

	this._processPendingReplaceTracks()
}

/**
 * Process pending replace track actions.
 *
 * All the pending replace track actions are executed from the oldest to the
 * newest, waiting until the previous action was executed before executing the
 * next one.
 *
 * The process may be stopped if the connection is lost, or if a track needs to
 * be added rather than replaced, which requires a renegotiation. In both cases
 * the process will start again once the connection is restablished.
 *
 * @returns {Promise} a Promise fulfilled when the processing ends; if it was
 *          completed the resolved value is true, and if it was stopped before
 *          finishing the resolved value is false.
 */
Peer.prototype._processPendingReplaceTracks = function() {
	if (this._processPendingReplaceTracksPromise) {
		return this._processPendingReplaceTracksPromise
	}

	this._processPendingReplaceTracksPromise = this._processPendingReplaceTracksAsync()

	// For compatibility with older browsers "finally" should not be used on
	// Promises.
	this._processPendingReplaceTracksPromise.then(() => {
		this._processPendingReplaceTracksPromise = null
	}).catch(() => {
		this._processPendingReplaceTracksPromise = null
	})

	return this._processPendingReplaceTracksPromise
}

Peer.prototype._processPendingReplaceTracksAsync = async function() {
	while (this._pendingReplaceTracksQueue.length > 0) {
		if (this.pc.iceConnectionState === 'new') {
			// Do not replace the tracks when the connection has not started
			// yet, as Firefox can get "stuck" and not replace the tracks even
			// if tried later again once connected.
			return false
		}

		const pending = this._pendingReplaceTracksQueue.shift()

		try {
			await this._replaceTrack(pending.newTrack, pending.oldTrack, pending.stream)
		} catch (exception) {
			// If the track is added instead of replaced a renegotiation will be
			// needed, so stop replacing tracks.
			return false
		}
	}

	return true
}

/**
 * Replaces the old track with the new track in the appropriate sender.
 *
 * If the new track is disabled the old track will be replaced by a null track
 * instead, which stops the sent data. The old and new tracks can be the same
 * track, which can be used to start or stop sending the track data depending on
 * whether the track is enabled or disabled (at the time of being passed to this
 * method).
 *
 * If a new track is provided but no sender was found the new track is added
 * instead of replaced (which will require a renegotiation).
 *
 * The method returns a promise which is fulfilled once the track was replaced
 * in the appropriate sender, or immediately if no sender was found and no track
 * was added. If a track had to be added the promise is rejected instead.
 *
 * @param {MediaStreamTrack|null} newTrack the new track to set.
 * @param {MediaStreamTrack|null} oldTrack the old track to be replaced.
 * @param {MediaStream} stream the stream that the new track belongs to.
 * @returns {Promise}
 */
Peer.prototype._replaceTrack = async function(newTrack, oldTrack, stream) {
	let senderFound = false

	// The track should be replaced in just one sender, but an array of promises
	// is used to be on the safe side.
	const replaceTrackPromises = []

	this.pc.getSenders().forEach(sender => {
		if (sender.track !== oldTrack && sender.trackDisabled !== oldTrack) {
			return
		}

		if ((sender.track || sender.trackDisabled) && !oldTrack) {
			return
		}

		if (!sender.track && !newTrack) {
			// The old track was disabled and thus already stopped, so it does
			// not need to be replaced, but the null track needs to be set as
			// the disabled track.
			if (sender.trackDisabled === oldTrack) {
				sender.trackDisabled = newTrack
			}

			return
		}

		if (!sender.kind && sender.track) {
			sender.kind = sender.track.kind
		} else if (!sender.kind && sender.trackDisabled) {
			sender.kind = sender.trackDisabled.kind
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

		// Save reference to trackDisabled to be able to restore it if the track
		// can not be replaced.
		const oldTrackDisabled = sender.trackDisabled

		if (newTrack && !newTrack.enabled) {
			sender.trackDisabled = newTrack
		} else {
			sender.trackDisabled = null
		}

		if (!sender.track && !newTrack.enabled) {
			// Nothing to replace now, it will be done once the track is
			// enabled.
			return
		}

		if (sender.track && newTrack && !newTrack.enabled) {
			// Replace with a null track to stop the sender.
			newTrack = null
		}

		const replaceTrackPromise = sender.replaceTrack(newTrack)

		replaceTrackPromise.catch(error => {
			sender.trackDisabled = oldTrackDisabled

			if (error.name === 'InvalidModificationError') {
				console.debug('Track could not be replaced, negotiation needed')
			} else {
				console.error('Track could not be replaced: ', error, oldTrack, newTrack)
			}
		})

		replaceTrackPromises.push(replaceTrackPromise)
	})

	// If the call started when the audio or video device was not active there
	// will be no sender for that type. In that case the track needs to be added
	// instead of replaced.
	if (!senderFound && newTrack) {
		this.pc.addTrack(newTrack, stream)

		return Promise.reject(new Error('Track added instead of replaced'))
	}

	return Promise.allSettled(replaceTrackPromises)
}

Peer.prototype.handleLocalTrackEnabledChanged = function(track, stream) {
	const sender = this.pc.getSenders().find(sender => sender.track === track)
	const stoppedSender = this.pc.getSenders().find(sender => sender.trackDisabled === track)

	if (track.enabled && stoppedSender) {
		this.handleLocalTrackReplacedBound(track, track, stream)
	} else if (!track.enabled && sender) {
		this.handleLocalTrackReplacedBound(track, track, stream)
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
