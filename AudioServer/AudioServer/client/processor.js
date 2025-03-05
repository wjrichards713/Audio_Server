class AudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.frameSize = options.processorOptions.frameSize || 128; // Default: 128, Override with 4096, 8192, etc.
        this.buffer = new Float32Array(this.frameSize); // Buffer to store samples
        this.index = 0;
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];

        if (input.length > 0) {
            const inputChannel = input[0];
            const outputChannel = output[0];

            for (let i = 0; i < inputChannel.length; i++) {
                outputChannel[i] = inputChannel[i]; // Direct playback
                
                // Store the samples in buffer
                this.buffer[this.index] = inputChannel[i];
                this.index++;

                // If buffer is full, send data and reset index
                if (this.index >= this.frameSize) {
                    this.port.postMessage(this.buffer.slice(0)); // Send audio to Electron
                    this.index = 0; // Reset buffer index
                }
            }
        }
        return true; // Keep processing
    }
}

// Register the processor
registerProcessor("audio-processor", AudioProcessor);
