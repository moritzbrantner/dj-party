export class AudioOutputRouter extends EventTarget {
  constructor() {
    super();
    this.context = null;
    this.monitorDestination = null;
    this.monitorMasterGain = null;
    this.headphoneDeviceId = null;
    this.masterDeviceId = null;
    this.monitorAudio = new Audio();
    this.monitorAudio.autoplay = false;
    this.monitorAudio.controls = false;
    this.monitorAudio.playsInline = true;
    this.handleDeviceChange = () => void this.verifySelectedOutputs();
    navigator.mediaDevices?.addEventListener?.("devicechange", this.handleDeviceChange);
  }

  supportsOutputSelection() {
    return Boolean(
      window.isSecureContext &&
        navigator.mediaDevices?.selectAudioOutput &&
        typeof this.monitorAudio.setSinkId === "function",
    );
  }

  supportsMasterOutputSelection() {
    return Boolean(this.supportsOutputSelection() && typeof AudioContext.prototype.setSinkId === "function");
  }

  attachContext(context) {
    if (this.context === context) {
      return;
    }
    if (this.context) {
      throw new Error("Audio output router is already attached to another AudioContext");
    }

    this.context = context;
    this.monitorDestination = context.createMediaStreamDestination();
    this.monitorMasterGain = context.createGain();
    this.monitorMasterGain.gain.value = 0;
    this.monitorMasterGain.connect(this.monitorDestination);
    this.monitorAudio.srcObject = this.monitorDestination.stream;
  }

  cueDestination() {
    return this.monitorDestination;
  }

  masterMonitorInput() {
    return this.monitorMasterGain;
  }

  async selectOutput() {
    if (!this.supportsOutputSelection()) {
      throw new Error("This browser cannot prompt for a separate audio output");
    }

    return navigator.mediaDevices.selectAudioOutput();
  }

  async useHeadphoneOutput(device) {
    if (!this.context || !this.monitorDestination) {
      throw new Error("Audio graph must be initialized before headphone routing");
    }
    if (!device?.deviceId || typeof this.monitorAudio.setSinkId !== "function") {
      throw new Error("Selected headphone output is unavailable");
    }

    await this.monitorAudio.setSinkId(device.deviceId);
    await this.monitorAudio.play();
    this.headphoneDeviceId = device.deviceId;
  }

  async useMasterOutput(device) {
    if (!this.context || typeof this.context.setSinkId !== "function") {
      throw new Error("This browser cannot route the master AudioContext to a selected output");
    }
    if (!device?.deviceId) {
      throw new Error("Selected master output is unavailable");
    }

    await this.context.setSinkId(device.deviceId);
    this.masterDeviceId = device.deviceId;
  }

  setMasterMonitorGain(value) {
    if (!this.context || !this.monitorMasterGain) {
      return;
    }

    const gain = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    this.monitorMasterGain.gain.setTargetAtTime(gain, this.context.currentTime, 0.012);
  }

  headphoneOutputReady() {
    return Boolean(this.headphoneDeviceId && !this.monitorAudio.paused);
  }

  async verifySelectedOutputs() {
    if (!navigator.mediaDevices?.enumerateDevices || (!this.headphoneDeviceId && !this.masterDeviceId)) {
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = new Set(
        devices.filter((device) => device.kind === "audiooutput").map((device) => device.deviceId),
      );

      if (this.headphoneDeviceId && !outputs.has(this.headphoneDeviceId)) {
        this.monitorAudio.pause();
        this.headphoneDeviceId = null;
        this.dispatchEvent(new Event("headphoneoutputlost"));
      }

      if (this.masterDeviceId && !outputs.has(this.masterDeviceId)) {
        this.masterDeviceId = null;
        this.dispatchEvent(new Event("masteroutputlost"));
      }
    } catch (error) {
      console.warn("Could not verify selected audio outputs", error);
    }
  }

  destroy() {
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.handleDeviceChange);
    this.monitorAudio.pause();
    this.monitorAudio.srcObject = null;
    for (const track of this.monitorDestination?.stream?.getTracks?.() ?? []) {
      track.stop();
    }
    this.monitorMasterGain?.disconnect();
    this.monitorDestination?.disconnect();
    this.context = null;
    this.monitorDestination = null;
    this.monitorMasterGain = null;
    this.headphoneDeviceId = null;
    this.masterDeviceId = null;
  }
}

export function outputDeviceLabel(device, fallback) {
  const label = device?.label?.trim();
  return label || fallback;
}
