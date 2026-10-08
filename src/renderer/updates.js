// The update bar.
//
// A new release is an offer, never an event that happens to you: nothing is
// downloaded until the bar is acted on, and nothing is installed until the
// download has been checked against the hash the release published.

import { el } from './util.js';

export class Updates {
  /**
   * @param {object} api    the preload bridge (window.plume)
   * @param {Function} toast the app's notification helper
   */
  constructor(api, toast) {
    this.api = api;
    this.toast = toast;

    this.bar = document.getElementById('update-bar');
    this.text = document.getElementById('update-bar-text');
    this.notes = document.getElementById('update-notes');
    this.go = document.getElementById('update-go');
    this.later = document.getElementById('update-later');

    this.update = null;
    this.canInstall = false;
    this.downloading = false;
    // Set once the download has been verified. The bar's one button means
    // "download" before that and "install" after, which is why there is a flag
    // here rather than a second click handler: two handlers on one button both
    // fire, and the second download deletes the installer the first just
    // handed to the system.
    this.ready = false;

    this.notes.addEventListener('click', () => this.api.update.page());
    this.later.addEventListener('click', () => this.dismiss());
    this.go.addEventListener('click', () => this.act());

    this.api.onUpdateAvailable(update => this.show(update));
    this.api.onUpdateProgress(progress => this.progress(progress));

    this.api.update.state().then(state => {
      this.canInstall = state.canInstall;
      if (state.update) this.show(state.update);
    });
  }

  show(update) {
    if (!update) return;
    this.update = update;
    this.canInstall = Boolean(update.installable);
    this.ready = false;

    this.text.replaceChildren(
      el('b', { text: `Plume ${update.version} is available.` }),
      document.createTextNode(this.canInstall
        ? ' It can install itself when you are ready.'
        : ' Open the download page to get it.'),
    );
    this.go.textContent = this.canInstall ? 'Install' : 'Download';
    this.go.disabled = false;
    this.bar.hidden = false;
  }

  progress({ percent, read, total }) {
    if (!this.downloading) return;
    let bar = this.text.querySelector('.update-progress');
    if (!bar) {
      bar = el('span', { class: 'update-progress' });
      bar.append(el('i'));
      this.text.append(bar);
    }
    bar.firstChild.style.width = `${percent || 0}%`;
    const mb = n => (n / 1048576).toFixed(1);
    this.go.textContent = total ? `Downloading ${mb(read)} / ${mb(total)} MB` : 'Downloading…';
  }

  async act() {
    if (!this.update || this.downloading) return;

    // Where Plume cannot replace itself — an unsigned app on macOS, or a
    // package the system owns on Linux — the honest offer is the download page.
    if (!this.canInstall) {
      await this.api.update.page();
      this.bar.hidden = true;
      return;
    }

    if (this.ready) return this.installNow();

    this.downloading = true;
    this.go.disabled = true;
    this.later.disabled = true;

    const res = await this.api.update.download();

    this.downloading = false;
    this.later.disabled = false;

    if (!res.ok) {
      this.ready = false;
      this.go.disabled = false;
      this.go.textContent = 'Install';
      this.text.replaceChildren(
        el('b', { text: 'That update could not be installed.' }),
        document.createTextNode(` ${res.error}`),
      );
      return;
    }

    this.ready = true;
    this.text.replaceChildren(
      el('b', { text: `Plume ${this.update.version} is ready.` }),
      document.createTextNode(' Plume will close while it installs, then reopen.'),
    );
    this.go.textContent = 'Install and restart';
    this.go.disabled = false;
  }

  /** The same button, once there is something verified to install. */
  async installNow() {
    this.go.disabled = true;
    const done = await this.api.update.install();
    if (!done.ok) {
      this.go.disabled = false;
      this.toast(done.error, 'error');
    }
  }

  /** Not now means not now, and not again for this version. */
  dismiss() {
    this.bar.hidden = true;
    if (this.update) this.api.update.skip(this.update.version);
  }
}
