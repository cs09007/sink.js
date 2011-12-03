(function (global){

/**
 * Creates a Sink according to specified parameters, if possible.
 *
 * @param {Function} readFn A callback to handle the buffer fills.
 * @param {number} channelCount Channel count.
 * @param {number} bufferSize (Optional) Specifies a pre-buffer size to control the amount of latency.
 * @param {number} sampleRate Sample rate (ms).
*/
function Sink(readFn, channelCount, bufferSize, sampleRate){
	var	sinks	= Sink.sinks,
		dev;
	for (dev in sinks){
		if (sinks.hasOwnProperty(dev) && sinks[dev].enabled){
			try{
				return new sinks[dev](readFn, channelCount, bufferSize, sampleRate);
			} catch(e1){}
		}
	}

	throw Sink.Error(0x02);
}

/**
 * A light event emitter.
*/
function EventEmitter () {
	var k;
	for (k in EventEmitter.prototype) {
		if (EventEmitter.prototype.hasOwnProperty(k)) {
			this[k] = EventEmitter.prototype[k];
		}
	}
	this._listeners = {};
};

EventEmitter.prototype = {
	_listeners: null,
	emit: function (name, args) {
		if (this._listeners[name]) {
			for (var i=0; i<this._listeners[name].length; i++) {
				this._listeners[name][i].apply(this, args);
			}
		}
		return this;
	},
	on: function (name, listener) {
		this._listeners[name] = this._listeners[name] || [];
		this._listeners[name].push(listener);
		return this;
	},
	off: function (name, listener) {
		if (this._listeners[name]) {
			for (var i=0; i<this._listeners[name].length; i++) {
				if (this._listeners[name][i] === listener) {
					this._listeners[name].splice(i--, 1);
				}
			}
		}
		this._listeners[name].length || delete this._listeners[name];
		return this;
	},
};

Sink.EventEmitter = EventEmitter;

/*
 * A Sink-specific error class.
*/

function SinkError(code) {
	if (!SinkError.hasOwnProperty(code)) throw SinkError(1);
	if (!(this instanceof SinkError)) return new SinkError(code);

	var k;
	for (k in SinkError[code]) {
		if (SinkError[code].hasOwnProperty(k)) {
			this[k] = SinkError[code][k];
		}
	}

	this.code = code;
}

SinkError.prototype = new Error();

SinkError.prototype.toString = function () {
	return 'SinkError 0x' + this.code.toString(16) + ': ' + this.message;
};

SinkError[0x01] = {
	message: 'No such error code.',
	explanation: 'The error code does not exist.',
};
SinkError[0x02] = {
	message: 'No audio sink available.',
	explanation: 'The audio device may be busy, or no supported output API is available for this browser.',
};

SinkError[0x10] = {
	message: 'Buffer underflow.',
	explanation: 'Trying to recover...',
};
SinkError[0x11] = {
	message: 'Critical recovery fail.',
	explanation: 'The buffer underflow has reached a critical point, trying to recover, but will probably fail anyway.',
};
SinkError[0x12] = {
	message: 'Buffer size too large.',
	explanation: 'Unable to allocate the buffer due to excessive length, please try a smaller buffer. Buffer size should probably be smaller than the sample rate.',
};

Sink.Error = SinkError;

/**
 * A Recording class for recording sink output.
 *
 * @private
 * @this {Recording}
 * @constructor
 * @param {Object} bindTo The sink to bind the recording to.
*/

function Recording(bindTo){
	this.boundTo = bindTo;
	this.buffers = [];
	bindTo.activeRecordings.push(this);
}

Recording.prototype = {
/**
 * Adds a new buffer to the recording.
 *
 * @param {Array} buffer The buffer to add.
*/
	add: function(buffer){
		this.buffers.push(buffer);
	},
/**
 * Empties the recording.
*/
	clear: function(){
		this.buffers = [];
	},
/**
 * Stops the recording and unbinds it from it's host sink.
*/
	stop: function(){
		var	recordings = this.boundTo.activeRecordings,
			i;
		for (i=0; i<recordings.length; i++){
			if (recordings[i] === this){
				recordings.splice(i--, 1);
			}
		}
	},
/**
 * Joins the recorded buffers into a single buffer.
*/
	join: function(){
		var	bufferLength	= 0,
			bufPos		= 0,
			buffers		= this.buffers,
			newArray,
			n, i, l		= buffers.length;

		for (i=0; i<l; i++){
			bufferLength += buffers[i].length;
		}
		newArray = new Float32Array(bufferLength);
		for (i=0; i<l; i++){
			for (n=0; n<buffers[i].length; n++){
				newArray[bufPos + n] = buffers[i][n];
			}
			bufPos += buffers[i].length;
		}
		return newArray;
	}
};

function SinkClass(){
}

Sink.SinkClass		= SinkClass;

SinkClass.prototype = {
/**
 * The sample rate of the Sink.
*/
	sampleRate: 44100,
/**
 * The channel count of the Sink.
*/
	channelCount: 2,
/**
 * The amount of samples to pre buffer for the sink.
*/
	bufferSize: 4096,
/**
 * Write position of the sink, as in how many samples have been written per channel.
*/
	writePosition: 0,
/**
 * The default mode of writing to the sink.
*/
	writeMode: 'async',
/**
 * The mode in which the sink asks the sample buffers to be channeled in.
*/
	channelMode: 'interleaved',
/**
 * The previous time of a callback.
*/
	previousHit: 0,
/**
 * The ring buffer array of the sink. If null, ring buffering will not be applied.
*/
	ringBuffer: null,
/**
 * The current position of the ring buffer.
 * @private
*/
	ringOffset: 0,
/**
 * Does the initialization of the sink.
 * @private
*/
	start: function(readFn, channelCount, bufferSize, sampleRate){
		this.channelCount	= isNaN(channelCount) || channelCount === null ? this.channelCount: channelCount;
		this.bufferSize	= isNaN(bufferSize) || bufferSize === null ? this.bufferSize : bufferSize;
		this.sampleRate		= isNaN(sampleRate) || sampleRate === null ? this.sampleRate : sampleRate;
		this.readFn		= readFn;
		this.activeRecordings	= [];
		this.previousHit	= +new Date;
		this.asyncBuffers	= [];
		this.syncBuffers	= [];
		Sink.EventEmitter.call(this);
	},
/**
 * The method which will handle all the different types of processing applied on a callback.
 * @private
*/
	process: function(soundData, channelCount) {
		this.ringBuffer && (this.channelMode === 'interleaved' ? this.ringSpin : this.ringSpinInterleaved).apply(this, arguments);
		this.writeBuffersSync.apply(this, arguments);
		if (this.channelMode === 'interleaved') {
			this.readFn && this.readFn.apply(this, arguments);
			this.emit('audioprocess', arguments);
		} else {
			var	soundDataSplit	= Sink.deinterleave(soundData, this.channelCount),
				args		= [soundDataSplit].concat([].slice.call(arguments, 1));
			this.readFn && this.readFn.apply(this, args);
			this.emit('audioprocess', args);
			Sink.interleave(soundDataSplit, this.channelCount, soundData);
		}
		this.writeBuffersAsync.apply(this, arguments);
		this.recordData.apply(this, arguments);
		this.previousHit = +new Date;
		this.writePosition += soundData.length / channelCount;
	},
/**
 * Starts recording the sink output.
 *
 * @return {Recording} The recording object for the recording started.
*/
	record: function(){
		return new Recording(this);
	},
/**
 * Private method that handles the adding the buffers to all the current recordings.
 *
 * @private
 * @param {Array} buffer The buffer to record.
*/
	recordData: function(buffer){
		var	activeRecs	= this.activeRecordings,
			i, l		= activeRecs.length;
		for (i=0; i<l; i++){
			activeRecs[i].add(buffer);
		}
	},
/**
 * Private method that handles the mixing of asynchronously written buffers.
 *
 * @private
 * @param {Array} buffer The buffer to write to.
*/
	writeBuffersAsync: function(buffer){
		var	buffers		= this.asyncBuffers,
			l		= buffer.length,
			buf,
			bufLength,
			i, n, offset;
		if (buffers){
			for (i=0; i<buffers.length; i++){
				buf		= buffers[i];
				bufLength	= buf.b.length;
				offset		= buf.d;
				buf.d		-= Math.min(offset, l);
				
				for (n=0; n + offset < l && n < bufLength; n++){
					buffer[n + offset] += buf.b[n];
				}
				buf.b = buf.b.subarray(n + offset);
				i >= bufLength && buffers.splice(i--, 1);
			}
		}
	},
/**
 * A private method that handles mixing synchronously written buffers.
 *
 * @private
 * @param {Array} buffer The buffer to write to.
*/
	writeBuffersSync: function(buffer){
		var	buffers		= this.syncBuffers,
			l		= buffer.length,
			i		= 0,
			soff		= 0;
		for(;i<l && buffers.length; i++){
			buffer[i] += buffers[0][soff];
			if (buffers[0].length <= soff){
				buffers.splice(0, 1);
				soff = 0;
				continue;
			}
			soff++;
		}
		if (buffers.length){
			buffers[0] = buffers[0].subarray(soff);
		}
	},
/**
 * Writes a buffer asynchronously on top of the existing signal, after a specified delay.
 *
 * @param {Array} buffer The buffer to write.
 * @param {Number} delay The delay to write after. If not specified, the Sink will calculate a delay to compensate the latency.
 * @return {Number} The number of currently stored asynchronous buffers.
*/
	writeBufferAsync: function(buffer, delay){
		buffer			= this.mode === 'deinterleaved' ? Sink.interleave(buffer, this.channelCount) : buffer;
		var	buffers		= this.asyncBuffers;
		buffers.push({
			b: buffer,
			d: isNaN(delay) ? ~~((+new Date - this.previousHit) / 1000 * this.sampleRate) : delay
		});
		return buffers.length;
	},
/**
 * Writes a buffer synchronously to the output.
 *
 * @param {Array} buffer The buffer to write.
 * @return {Number} The number of currently stored synchronous buffers.
*/
	writeBufferSync: function(buffer){
		buffer			= this.mode === 'deinterleaved' ? Sink.interleave(buffer, this.channelCount) : buffer;
		var	buffers		= this.syncBuffers;
		buffers.push(buffer);
		return buffers.length;
	},
/**
 * Writes a buffer, according to the write mode specified.
 *
 * @param {Array} buffer The buffer to write.
 * @param {Number} delay The delay to write after. If not specified, the Sink will calculate a delay to compensate the latency. (only applicable in asynchronous write mode)
 * @return {Number} The number of currently stored (a)synchronous buffers.
*/
	writeBuffer: function(){
		return this[this.writeMode === 'async' ? 'writeBufferAsync' : 'writeBufferSync'].apply(this, arguments);
	},
/**
 * Gets the total amount of yet unwritten samples in the synchronous buffers.
 *
 * @return {Number} The total amount of yet unwritten samples in the synchronous buffers.
*/
	getSyncWriteOffset: function(){
		var	buffers		= this.syncBuffers,
			offset		= 0,
			i;
		for (i=0; i<buffers.length; i++){
			offset += buffers[i].length;
		}
		return offset;
	},
/**
 * Get the current output position, defaults to writePosition - bufferSize.
 *
 * @return {Number} The position of the write head, in samples, per channel.
*/
	getPlaybackTime: function(){
		return this.writePosition - this.bufferSize;
	},
/**
 * A private method that applies the ring buffer contents to the specified buffer, while in interleaved mode.
 *
 * @private
 * @param {Array} buffer The buffer to write to.
*/
	ringSpin: function(buffer){
		var	ring	= this.ringBuffer,
			l	= buffer.length,
			m	= ring.length,
			off	= this.ringOffset,
			i;
		for (i=0; i<l; i++){
			buffer[i] += ring[off];
			off = (off + 1) % m;
		}
		this.ringOffset = off;
	},
/**
 * A private method that applies the ring buffer contents to the specified buffer, while in deinterleaved mode.
 *
 * @private
 * @param {Array} buffer The buffers to write to.
*/
	ringSpinDeinterleaved: function(buffer){
		var	ring	= this.ringBuffer,
			l	= buffer.length,
			ch	= ring.length,
			m	= ring[0].length,
			len	= ch * m,
			off	= this.ringOffset,
			i, n;
		for (i=0; i<l; i+=ch){
			for (n=0; n<ch; n++){
				buffer[i + n] += ring[n][off];
			}
			off = (off + 1) % m;
		}
		this.ringOffset = n;
	}
};

/**
 * The container for all the available sinks. Also a decorator function for creating a new Sink class and binding it.
 *
 * @param {String} type The name / type of the Sink.
 * @param {Function} constructor The constructor function for the Sink.
 * @param {Object} prototype The prototype of the Sink. (optional)
 * @param {Boolean} disabled Whether the Sink should be disabled at first.
*/

function sinks(type, constructor, prototype, disabled){
	prototype = prototype || constructor.prototype;
	constructor.prototype = new Sink.SinkClass();
	constructor.prototype.type = type;
	constructor.enabled = !disabled;
	for (disabled in prototype){
		if (prototype.hasOwnProperty(disabled)){
			constructor.prototype[disabled] = prototype[disabled];
		}
	}
	sinks[type] = constructor;
}

/**
 * A Sink class for the Mozilla Audio Data API.
*/

sinks('moz', function(){
	var	self			= this,
		currentWritePosition	= 0,
		tail			= null,
		audioDevice		= new Audio(),
		written, currentPosition, available, soundData, prevPos,
		timer; // Fix for https://bugzilla.mozilla.org/show_bug.cgi?id=630117
	self.start.apply(self, arguments);
	self.preBufferSize = isNaN(arguments[4]) || arguments[4] === null ? this.preBufferSize : arguments[4];

	function bufferFill(){
		if (tail){
			written = audioDevice.mozWriteAudio(tail);
			currentWritePosition += written;
			if (written < tail.length){
				tail = tail.subarray(written);
				return tail;
			}
			tail = null;
		}

		currentPosition = audioDevice.mozCurrentSampleOffset();
		available = Number(currentPosition + (prevPos !== currentPosition ? self.bufferSize : self.preBufferSize) * self.channelCount - currentWritePosition);
		currentPosition === prevPos && self.emit('error', [Sink.Error(0x10)]);
		if (available > 0 || prevPos === currentPosition){
			try {
				soundData = new Float32Array(prevPos === currentPosition ? self.preBufferSize * self.channelCount : available);
			} catch(e) {
				self.emit('error', [Sink.Error(0x12)]);
				self.kill();
				return;
			}
			self.process(soundData, self.channelCount);
			written = self._audio.mozWriteAudio(soundData);
			if (written < soundData.length){
				tail = soundData.subarray(written);
			}
			currentWritePosition += written;
		}
		prevPos = currentPosition;
	}

	audioDevice.mozSetup(self.channelCount, self.sampleRate);

	this._timers = [];

	this._timers.push(Sink.doInterval(function () {
		// Check for complete death of the output
		if (+new Date - self.previousHit > 2000) {
			self._audio = audioDevice = new Audio();
			audioDevice.mozSetup(self.channelCount, self.sampleRate);
			currentWritePosition = 0;
			self.emit('error', [Sink.Error(0x11)]);
		}
	}, 1000));

	this._timers.push(Sink.doInterval(bufferFill, 20));

	self._bufferFill	= bufferFill;
	self._audio		= audioDevice;
}, {
	// These are somewhat safe values...
	bufferSize: 24576,
	preBufferSize: 24576,
	kill: function () {
		while(this._timers.length){
			this._timers[0]();
			this._timers.splice(0, 1);
		}
		this.emit('kill');
	},
	getPlaybackTime: function() {
		return this._audio.mozCurrentSampleOffset() / this.channelCount;
	}
});

/**
 * A sink class for the Web Audio API
*/

var fixChrome82795 = [];

sinks('webkit', function(readFn, channelCount, bufferSize, sampleRate){
	var	self		= this,
		// For now, we have to accept that the AudioContext is at 48000Hz, or whatever it decides.
		context		= new (window.AudioContext || webkitAudioContext)(/*sampleRate*/),
		node		= context.createJavaScriptNode(bufferSize, 0, channelCount);
	self.start.apply(self, arguments);

	function bufferFill(e){
		var	outputBuffer	= e.outputBuffer,
			channelCount	= outputBuffer.numberOfChannels,
			i, n, l		= outputBuffer.length,
			size		= outputBuffer.size,
			channels	= new Array(channelCount),
			soundData	= new Float32Array(l * channelCount),
			tail;

		for (i=0; i<channelCount; i++){
			channels[i] = outputBuffer.getChannelData(i);
		}

		self.process(soundData, self.channelCount);

		for (i=0; i<l; i++){
			for (n=0; n < channelCount; n++){
				channels[n][i] = soundData[i * self.channelCount + n];
			}
		}
	}

	if (sinks.webkit.forceSampleRate && self.sampleRate !== context.sampleRate){
		bufferFill = function bufferFill(e){
			var	outputBuffer	= e.outputBuffer,
				channelCount	= outputBuffer.numberOfChannels,
				i, n, l		= outputBuffer.length,
				size		= outputBuffer.size,
				channels	= new Array(channelCount),
				soundData	= new Float32Array(Math.floor(l * self.sampleRate / context.sampleRate) * channelCount),
				channel;

			for (i=0; i<channelCount; i++){
				channels[i] = outputBuffer.getChannelData(i);
			}

			self.process(soundData, self.channelCount);
			soundData = Sink.deinterleave(soundData, self.channelCount);
			for (n=0; n<channelCount; n++){
				channel = Sink.resample(soundData[n], self.sampleRate, context.sampleRate);
				for (i=0; i<l; i++){
					channels[n][i] = channel[i];
				}
			}
		}
	} else {
		self.sampleRate = context.sampleRate;
	}

	node.onaudioprocess = bufferFill;
	node.connect(context.destination);

	self._context		= context;
	self._node		= node;
	self._callback		= bufferFill;
	/* Keep references in order to avoid garbage collection removing the listeners, working around http://code.google.com/p/chromium/issues/detail?id=82795 */
	// Thanks to @baffo32
	fixChrome82795.push(node);
}, {
	//TODO: Do something here.
	kill: function(){
		this._node.disconnect(0);
		for (var i=0; i<fixChrome82795.length; i++) {
			fixChrome82795[i] === this._node && fixChrome82795.splice(i--, 1);
		}
		this._node = this._context = null;
		this.kill();
		this.emit('kill');
	},
	getPlaybackTime: function(){
		return this._context.currentTime * this.sampleRate;
	},
});

sinks.webkit.fix82795 = fixChrome82795;

/**
 * A dummy Sink. (No output)
*/

sinks('dummy', function(){
	var 	self		= this;
	self.start.apply(self, arguments);
	
	function bufferFill(){
		var	soundData = new Float32Array(self.bufferSize * self.channelCount);
		self.process(soundData, self.channelCount);
	}

	self._kill = Sink.doInterval(bufferFill, self.bufferSize / self.sampleRate * 1000);

	self._callback		= bufferFill;
}, {
	kill: function () {
		this._kill();
		this.emit('kill');
	},
}, true);

Sink.sinks		= Sink.devices = sinks;
Sink.Recording		= Recording;

Sink.doInterval		= function(callback, timeout){
	var	BlobBuilder	= typeof window === 'undefined' ? undefined : window.MozBlobBuilder || window.WebKitBlobBuilder || window.MSBlobBuilder || window.OBlobBuilder || window.BlobBuilder,
		timer, id, prev;
	if ((Sink.doInterval.backgroundWork || Sink.devices.moz.backgroundWork) && BlobBuilder){
		try{
			prev	= new BlobBuilder();
			prev.append('setInterval(function(){ postMessage("tic"); }, ' + timeout + ');');
			id	= (window.MozURL || window.webkitURL || window.MSURL || window.OURL || window.URL).createObjectURL(prev.getBlob());
			timer	= new Worker(id);
			timer.onmessage = function(){
				callback();
			};
			return function(){
				timer.terminate();
				(window.MozURL || window.webkitURL || window.MSURL || window.OURL || window.URL).revokeObjectURL(id);
			};
		} catch(e){};
	}
	timer = setInterval(callback, timeout);
	return function(){
		clearInterval(timer);
	};
};

Sink.doInterval.backgroundWork = true;

(function(){

/**
 * If method is supplied, adds a new interpolation method to Sink.interpolation, otherwise sets the default interpolation method (Sink.interpolate) to the specified property of Sink.interpolate.
 *
 * @param {String} name The name of the interpolation method to get / set.
 * @param {Function} method The interpolation method. (Optional)
*/

function interpolation(name, method){
	if (name && method){
		interpolation[name] = method;
	} else if (name && interpolation[name] instanceof Function){
		Sink.interpolate = interpolation[name];
	}
	return interpolation[name];
}

Sink.interpolation = interpolation;


/**
 * Interpolates a fractal part position in an array to a sample. (Linear interpolation)
 *
 * @param {Array} arr The sample buffer.
 * @param {number} pos The position to interpolate from.
 * @return {Float32} The interpolated sample.
*/
interpolation('linear', function(arr, pos){
	var	first	= Math.floor(pos),
		second	= first + 1,
		frac	= pos - first;
	second		= second < arr.length ? second : 0;
	return arr[first] * (1 - frac) + arr[second] * frac;
});

/**
 * Interpolates a fractal part position in an array to a sample. (Nearest neighbour interpolation)
 *
 * @param {Array} arr The sample buffer.
 * @param {number} pos The position to interpolate from.
 * @return {Float32} The interpolated sample.
*/
interpolation('nearest', function(arr, pos){
	return pos >= arr.length - 0.5 ? arr[0] : arr[Math.round(pos)];
});

interpolation('linear');

}());


/**
 * Resamples a sample buffer from a frequency to a frequency and / or from a sample rate to a sample rate.
 *
 * @param {Float32Array} buffer The sample buffer to resample.
 * @param {number} fromRate The original sample rate of the buffer, or if the last argument, the speed ratio to convert with.
 * @param {number} fromFrequency The original frequency of the buffer, or if the last argument, used as toRate and the secondary comparison will not be made.
 * @param {number} toRate The sample rate of the created buffer.
 * @param {number} toFrequency The frequency of the created buffer.
*/
Sink.resample	= function(buffer, fromRate /* or speed */, fromFrequency /* or toRate */, toRate, toFrequency){
	var
		argc		= arguments.length,
		speed		= argc === 2 ? fromRate : argc === 3 ? fromRate / fromFrequency : toRate / fromRate * toFrequency / fromFrequency,
		l		= buffer.length,
		length		= Math.ceil(l / speed),
		newBuffer	= new Float32Array(length),
		i, n;
	for (i=0, n=0; i<l; i += speed){
		newBuffer[n++] = Sink.interpolate(buffer, i);
	}
	return newBuffer;
};

/**
 * Splits a sample buffer into those of different channels.
 *
 * @param {Float32Array} buffer The sample buffer to split.
 * @param {number} channelCount The number of channels to split to.
 * @return {Array} An array containing the resulting sample buffers.
*/

Sink.deinterleave = function(buffer, channelCount){
	var	l	= buffer.length,
		size	= l / channelCount,
		ret	= [],
		i, n;
	for (i=0; i<channelCount; i++){
		ret[i] = new Float32Array(size);
		for (n=0; n<size; n++){
			ret[i][n] = buffer[n * channelCount + i];
		}
	}
	return ret;
};

/**
 * Joins an array of sample buffers into a single buffer.
 *
 * @param {Array} buffers The buffers to join.
 * @param {Number} channelCount The number of channels. Defaults to buffers.length
 * @param {Array} buffer The output buffer. (optional)
*/

Sink.interleave = function(buffers, channelCount, buffer){
	channelCount		= channelCount || buffers.length;
	var	l		= buffers[0].length,
		bufferCount	= buffers.length,
		i, n;
	buffer			= buffer || new Float32Array(l * channelCount);
	for (i=0; i<bufferCount; i++){
		for (n=0; n<l; n++){
			buffer[i + n * channelCount] = buffers[i][n];
		}
	}
	return buffer;
};

/**
 * Mixes two or more buffers down to one.
 *
 * @param {Array} buffer The buffer to append the others to.
 * @param {Array} bufferX The buffers to append from.
*/

Sink.mix = function(buffer){
	var	buffers	= [].slice.call(arguments, 1),
		l, i, c;
	for (c=0; c<buffers.length; c++){
		l = Math.max(buffer.length, buffers[c].length);
		for (i=0; i<l; i++){
			buffer[i] += buffers[c][i];
		}
	}
	return buffer;
};

/**
 * Resets a buffer to all zeroes.
 *
 * @param {Array} buffer The buffer to reset.
*/

Sink.resetBuffer = function(buffer){
	var	l	= buffer.length,
		i;
	for (i=0; i<l; i++){
		buffer[i] = 0;
	}
	return buffer;
};

/**
 * Copies the content of an array to another array.
 *
 * @param {Array} buffer The buffer to copy from.
 * @param {Array} result The buffer to copy to. Optional.
*/

Sink.clone = function(buffer, result){
	var	l	= buffer.length,
		i;
	result = result || new Float32Array(l);
	for (i=0; i<l; i++){
		result[i] = buffer[i];
	}
	return result;
};

/**
 * Creates an array of buffers of the specified length and the specified count.
 *
 * @param {Number} length The length of a single channel.
 * @param {Number} channelCount The number of channels.
 * @return {Array} The array of buffers.
*/

Sink.createDeinterleaved = function(length, channelCount){
	var	result	= new Array(channelCount),
		i;
	for (i=0; i<channelCount; i++){
		result[i] = new Float32Array(length);
	}
	return result;
};

global.Sink = Sink;
}(function(){ return this; }()));
