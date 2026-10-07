// Plume Vault — the graph of how your documents link to each other.
//
// Shared in spirit with the one on plume-md.com: the same force simulation,
// reading this app's theme variables rather than the website's.


// A small force simulation: links pull, every node pushes, and a weak pull
// to the middle stops disconnected clusters drifting off the canvas.
var REPULSION = 5200;
var SPRING = 0.015;
var SPRING_LENGTH = 62;
var CENTRING = 0.0016;
var DAMPING = 0.86;
var MAX_SPEED = 28;

// Enough hues to tell folders apart, spaced so neighbours never collide.
var HUES = [262, 190, 36, 150, 320, 12, 212, 96, 288, 56];

function Graph(canvas, options) {
  this.canvas = canvas;
  this.ctx = canvas.getContext('2d');
  this.opts = options || {};
  this.nodes = [];
  this.edges = [];
  this.byPath = new Map();
  this.hover = null;
  this.selected = null;
  this.scale = 1;
  this.offset = { x: 0, y: 0 };
  this.dragging = null;
  this.panning = null;
  this.alpha = 1;
  this.frame = null;
  this.running = false;

  this.bind();
}

// ---------- data ----------

Graph.prototype.setData = function (nodes, edges) {
  var self = this;
  var previous = this.byPath;
  var width = this.canvas.clientWidth || 600;
  var height = this.canvas.clientHeight || 400;

  var folders = [];
  this.nodes = nodes.map(function (n, i) {
    var folder = n.path.indexOf('/') === -1 ? '' : n.path.slice(0, n.path.lastIndexOf('/'));
    if (folders.indexOf(folder) === -1) folders.push(folder);

    var old = previous.get(n.path);
    // Keep a node where it already settled, so a refresh does not reshuffle
    // a layout the reader has learned.
    var angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    var radius = 40 + Math.min(width, height) * 0.3;
    return {
      path: n.path,
      name: n.name || n.path,
      folder: folder,
      links: n.links || 0,
      size: n.size || 0,
      updatedAt: n.updatedAt,
      x: old ? old.x : width / 2 + Math.cos(angle) * radius + (Math.random() - 0.5) * 24,
      y: old ? old.y : height / 2 + Math.sin(angle) * radius + (Math.random() - 0.5) * 24,
      vx: 0,
      vy: 0,
    };
  });

  this.folders = folders;
  this.byPath = new Map();
  this.nodes.forEach(function (n) {
    n.hue = HUES[folders.indexOf(n.folder) % HUES.length];
    self.byPath.set(n.path, n);
  });

  this.edges = edges
    .map(function (e) {
      return { from: self.byPath.get(e.from), to: self.byPath.get(e.to) };
    })
    .filter(function (e) { return e.from && e.to; });

  this.neighbours = new Map();
  this.edges.forEach(function (e) {
    if (!self.neighbours.has(e.from.path)) self.neighbours.set(e.from.path, new Set());
    if (!self.neighbours.has(e.to.path)) self.neighbours.set(e.to.path, new Set());
    self.neighbours.get(e.from.path).add(e.to.path);
    self.neighbours.get(e.to.path).add(e.from.path);
  });

  this.alpha = 1;
  this.start();
};

Graph.prototype.radiusOf = function (node) {
  return 4 + Math.min(11, Math.sqrt(node.links) * 2.6);
};

// ---------- simulation ----------

Graph.prototype.step = function () {
  var nodes = this.nodes;
  var i;
  var n = nodes.length;
  if (!n) return;

  var width = this.canvas.clientWidth || 600;
  var height = this.canvas.clientHeight || 400;
  var cx = width / 2;
  var cy = height / 2;

  for (i = 0; i < n; i += 1) {
    var a = nodes[i];
    for (var j = i + 1; j < n; j += 1) {
      var b = nodes[j];
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = (Math.random() - 0.5) * 2;
        dy = (Math.random() - 0.5) * 2;
        d2 = 1;
      }
      if (d2 > 160000) continue;   // far enough apart to ignore
      var d = Math.sqrt(d2);
      var push = (REPULSION / d2) * this.alpha;
      var ux = (dx / d) * push;
      var uy = (dy / d) * push;
      a.vx -= ux; a.vy -= uy;
      b.vx += ux; b.vy += uy;
    }
  }

  for (i = 0; i < this.edges.length; i += 1) {
    var e = this.edges[i];
    var ex = e.to.x - e.from.x;
    var ey = e.to.y - e.from.y;
    var ed = Math.sqrt(ex * ex + ey * ey) || 0.01;
    var force = (ed - SPRING_LENGTH) * SPRING * this.alpha;
    var fx = (ex / ed) * force;
    var fy = (ey / ed) * force;
    e.from.vx += fx; e.from.vy += fy;
    e.to.vx -= fx; e.to.vy -= fy;
  }

  var moved = 0;
  for (i = 0; i < n; i += 1) {
    var node = nodes[i];
    if (node === this.dragging) { node.vx = 0; node.vy = 0; continue; }
    node.vx += (cx - node.x) * CENTRING * this.alpha;
    node.vy += (cy - node.y) * CENTRING * this.alpha;
    node.vx *= DAMPING;
    node.vy *= DAMPING;

    var speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    if (speed > MAX_SPEED) {
      node.vx = (node.vx / speed) * MAX_SPEED;
      node.vy = (node.vy / speed) * MAX_SPEED;
    }
    node.x += node.vx;
    node.y += node.vy;
    moved += Math.abs(node.vx) + Math.abs(node.vy);
  }

  this.alpha *= 0.994;
  // Settled: stop burning frames until something changes.
  if (moved / n < 0.03 && this.alpha < 0.5) this.alpha = 0;
};

// ---------- drawing ----------

Graph.prototype.resize = function () {
  var dpr = window.devicePixelRatio || 1;
  var width = this.canvas.clientWidth;
  var height = this.canvas.clientHeight;
  if (!width || !height) return;
  this.canvas.width = Math.round(width * dpr);
  this.canvas.height = Math.round(height * dpr);
  this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  this.draw();
};

Graph.prototype.colours = function () {
  var styles = window.getComputedStyle(document.documentElement);
  var read = function (name, fallback) {
    var v = styles.getPropertyValue(name);
    return v && v.trim() ? v.trim() : fallback;
  };
  return {
    text: read('--text', '#1d1d22'),
    dim: read('--text-3', '#8b8b96'),
    line: read('--border', '#e4e4e9'),
    accent: read('--accent', '#6e56cf'),
    bg: read('--chrome', '#f6f6f8'),
  };
};

Graph.prototype.draw = function () {
  var ctx = this.ctx;
  var c = this.colours();
  var width = this.canvas.clientWidth;
  var height = this.canvas.clientHeight;
  if (!width || !height) return;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, width, height);

  ctx.translate(this.offset.x, this.offset.y);
  ctx.scale(this.scale, this.scale);

  var focus = this.hover || this.selected;
  var near = focus ? this.neighbours.get(focus.path) : null;

  // edges
  ctx.lineWidth = 1 / this.scale;
  for (var i = 0; i < this.edges.length; i += 1) {
    var e = this.edges[i];
    var lit = focus && (e.from === focus || e.to === focus);
    ctx.strokeStyle = lit ? c.accent : c.line;
    ctx.globalAlpha = focus ? (lit ? 0.9 : 0.18) : 0.55;
    ctx.beginPath();
    ctx.moveTo(e.from.x, e.from.y);
    ctx.lineTo(e.to.x, e.to.y);
    ctx.stroke();
  }

  // nodes
  ctx.globalAlpha = 1;
  for (var k = 0; k < this.nodes.length; k += 1) {
    var n = this.nodes[k];
    var r = this.radiusOf(n);
    var related = !focus || n === focus || (near && near.has(n.path));

    ctx.globalAlpha = related ? 1 : 0.25;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = n.links
      ? 'hsl(' + n.hue + ' 62% 58%)'
      : 'hsl(' + n.hue + ' 20% 62%)';
    ctx.fill();

    if (n === focus) {
      ctx.lineWidth = 2 / this.scale;
      ctx.strokeStyle = c.text;
      ctx.stroke();
    }
  }

  // labels, once there is room for them to be readable
  var showAll = this.scale > 1.25;
  ctx.globalAlpha = 1;
  ctx.font = (11 / this.scale) + 'px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (var m = 0; m < this.nodes.length; m += 1) {
    var node = this.nodes[m];
    var isFocus = node === focus;
    var isNear = near && near.has(node.path);
    if (!showAll && !isFocus && !isNear) continue;
    ctx.fillStyle = isFocus ? c.text : c.dim;
    ctx.globalAlpha = isFocus || isNear ? 1 : 0.75;
    var label = node.name.length > 26 ? node.name.slice(0, 25) + '…' : node.name;
    ctx.fillText(label, node.x, node.y + this.radiusOf(node) + 3 / this.scale);
  }

  ctx.restore();
};

Graph.prototype.tick = function () {
  var self = this;
  this.frame = window.requestAnimationFrame(function () {
    if (self.alpha > 0) self.step();
    self.draw();
    if (self.alpha > 0 || self.dragging) self.tick();
    else self.running = false;
  });
};

Graph.prototype.start = function () {
  if (this.running) return;
  this.running = true;
  this.tick();
};

Graph.prototype.nudge = function () {
  this.alpha = Math.max(this.alpha, 0.6);
  this.start();
};

// ---------- interaction ----------

Graph.prototype.at = function (clientX, clientY) {
  var rect = this.canvas.getBoundingClientRect();
  var x = (clientX - rect.left - this.offset.x) / this.scale;
  var y = (clientY - rect.top - this.offset.y) / this.scale;
  var best = null;
  var bestD = Infinity;
  for (var i = 0; i < this.nodes.length; i += 1) {
    var n = this.nodes[i];
    var dx = n.x - x;
    var dy = n.y - y;
    var d = Math.sqrt(dx * dx + dy * dy);
    var reach = this.radiusOf(n) + 6;
    if (d < reach && d < bestD) { best = n; bestD = d; }
  }
  return { node: best, x: x, y: y };
};

Graph.prototype.bind = function () {
  var self = this;
  var canvas = this.canvas;

  canvas.addEventListener('pointerdown', function (ev) {
    canvas.setPointerCapture(ev.pointerId);
    var hit = self.at(ev.clientX, ev.clientY);
    if (hit.node) {
      self.dragging = hit.node;
      self.selected = hit.node;
      self.nudge();
      if (self.opts.onSelect) self.opts.onSelect(hit.node);
    } else {
      self.panning = { x: ev.clientX - self.offset.x, y: ev.clientY - self.offset.y };
      self.selected = null;
      if (self.opts.onSelect) self.opts.onSelect(null);
      self.draw();
    }
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (self.dragging) {
      var rect = canvas.getBoundingClientRect();
      self.dragging.x = (ev.clientX - rect.left - self.offset.x) / self.scale;
      self.dragging.y = (ev.clientY - rect.top - self.offset.y) / self.scale;
      self.draw();
      return;
    }
    if (self.panning) {
      self.offset.x = ev.clientX - self.panning.x;
      self.offset.y = ev.clientY - self.panning.y;
      self.draw();
      return;
    }
    var hit = self.at(ev.clientX, ev.clientY);
    if (hit.node !== self.hover) {
      self.hover = hit.node;
      canvas.style.cursor = hit.node ? 'pointer' : 'grab';
      self.draw();
      if (self.opts.onHover) self.opts.onHover(hit.node);
    }
  });

  var release = function (ev) {
    if (self.dragging) self.nudge();
    self.dragging = null;
    self.panning = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* already gone */ }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('dblclick', function (ev) {
    var hit = self.at(ev.clientX, ev.clientY);
    if (hit.node && self.opts.onOpen) self.opts.onOpen(hit.node);
  });

  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var rect = canvas.getBoundingClientRect();
    var mx = ev.clientX - rect.left;
    var my = ev.clientY - rect.top;
    var factor = Math.pow(0.999, ev.deltaY);
    var next = Math.min(4, Math.max(0.25, self.scale * factor));
    // Zoom towards the pointer rather than the corner.
    self.offset.x = mx - ((mx - self.offset.x) / self.scale) * next;
    self.offset.y = my - ((my - self.offset.y) / self.scale) * next;
    self.scale = next;
    self.draw();
  }, { passive: false });
};

Graph.prototype.fit = function () {
  if (!this.nodes.length) return;
  var minX = Infinity; var minY = Infinity; var maxX = -Infinity; var maxY = -Infinity;
  this.nodes.forEach(function (n) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  });
  var pad = 48;
  var width = this.canvas.clientWidth;
  var height = this.canvas.clientHeight;
  var spanX = Math.max(1, maxX - minX);
  var spanY = Math.max(1, maxY - minY);
  // Capped well below the manual zoom limit: fitting three notes to a
  // full pane would otherwise draw them as giant discs.
  this.scale = Math.min(1.6, Math.max(0.25, Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY)));
  this.offset.x = width / 2 - ((minX + maxX) / 2) * this.scale;
  this.offset.y = height / 2 - ((minY + maxY) / 2) * this.scale;
  this.draw();
};

Graph.prototype.destroy = function () {
  if (this.frame) window.cancelAnimationFrame(this.frame);
  this.running = false;
};

export { Graph };
