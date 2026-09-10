/**
 * Diagnostic for instanced mesh invisibility on ANGLE/llvmpipe.
 * Run from repo root:  node diag-instanced.mjs
 * Requires: npm i playwright (already a dev dep), Vite dev server running on :5173
 *
 * IMPORTANT: clear the Vite cache first!
 *   rm -rf node_modules/.vite && npm run dev
 * Then in a separate terminal: node diag-instanced.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('./node_modules/playwright');

const browser = await chromium.launch({
  headless: false,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--enable-webgl2', '--ignore-gpu-blocklist'],
});
const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();

const diagResults = [];
function diag(label, value) {
  diagResults.push({ label, value });
  console.log(`[DIAG] ${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
}

page.on('console', msg => {
  const text = msg.text();
  if (text.startsWith('[DIAG]')) console.log(text);
});

await page.addInitScript(() => {
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  let hooked = false;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    const ctx = origGetContext.call(this, type, ...args);
    if (type === 'webgl2' && ctx && !hooked) {
      hooked = true;
      const gl = ctx;

      // 1. Renderer info
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      console.log('[DIAG] renderer: ' + (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a'));
      console.log('[DIAG] version: ' + gl.getParameter(gl.VERSION));
      console.log('[DIAG] maxVertexTextureUnits: ' + gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS));

      // 2. Track every pixelStorei(PREMULTIPLY) call
      const origPS = gl.pixelStorei.bind(gl);
      let premulCalls = 0;
      gl.pixelStorei = function(p, v) {
        if (p === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) {
          premulCalls++;
          if (premulCalls <= 30) console.log('[DIAG] pixelStorei(PREMULTIPLY, ' + v + ') #' + premulCalls);
        }
        return origPS(p, v);
      };

      // 3. Track texImage2D/texSubImage2D for RGBA32F — log premultiply state
      const origTI = gl.texImage2D.bind(gl);
      let tiCount = 0;
      gl.texImage2D = function(...a) {
        if (a[2] === gl.RGBA32F) {
          tiCount++;
          if (tiCount <= 10) {
            const premul = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
            const flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
            console.log('[DIAG] texImage2D RGBA32F #' + tiCount + ': ' + a[3] + 'x' + a[4] +
              ' premul=' + premul + ' flipY=' + flipY);
          }
        }
        return origTI(...a);
      };
      const origTSI = gl.texSubImage2D.bind(gl);
      let tsiCount = 0;
      gl.texSubImage2D = function(...a) {
        if (a.length >= 9 && a[7] === gl.FLOAT) {
          tsiCount++;
          if (tsiCount <= 10) {
            const premul = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
            console.log('[DIAG] texSubImage2D FLOAT #' + tsiCount + ': ' + a[4] + 'x' + a[5] +
              ' premul=' + premul);
          }
        }
        return origTSI(...a);
      };

      // 4. At draw time: readback palette texture
      const origDEI = gl.drawElementsInstanced.bind(gl);
      let deiCount = 0;
      gl.drawElementsInstanced = function(mode, count, type, offset, ic) {
        deiCount++;
        if (deiCount <= 20) {
          const prog = gl.getParameter(gl.CURRENT_PROGRAM);
          const loc = prog ? gl.getUniformLocation(prog, 'u_instancePalette') : null;
          if (loc !== null) {
            const unit = gl.getUniform(prog, loc);
            console.log('[DIAG] drawElementsInstanced #' + deiCount + ': instances=' + ic +
              ' paletteUnit=' + unit + ' elems=' + count);
            if (ic > 0 && deiCount <= 5) {
              try {
                gl.getExtension('EXT_color_buffer_float');
                const savedUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
                const savedFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                gl.activeTexture(gl.TEXTURE0 + unit);
                const tex = gl.getParameter(gl.TEXTURE_BINDING_2D);
                if (tex) {
                  const fb = gl.createFramebuffer();
                  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
                  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
                  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
                    const n = Math.max(ic, 1) * 4;
                    const rb = new Float32Array(n * 4);
                    gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, rb);
                    const first16 = Array.from(rb.subarray(0, 16)).map(v => v.toFixed(4));
                    const rotScaleZero = rb.subarray(0, 12).every(v => Math.abs(v) < 0.0001);
                    console.log('[DIAG] PALETTE AT DRAW: [' + first16.join(',') + ']');
                    console.log('[DIAG] rotation/scale zeroed=' + rotScaleZero +
                      (rotScaleZero ? ' *** PREMULTIPLY BUG STILL ACTIVE ***' : ' (data looks correct)'));
                  } else {
                    console.log('[DIAG] readback FB incomplete');
                  }
                  gl.bindFramebuffer(gl.FRAMEBUFFER, savedFb);
                  gl.deleteFramebuffer(fb);
                } else {
                  console.log('[DIAG] no texture on palette unit ' + unit);
                }
                gl.activeTexture(savedUnit);
              } catch (e) {
                console.log('[DIAG] readback error: ' + e);
              }
            }
          }
        }
        return origDEI(mode, count, type, offset, ic);
      };

      // 5. Standalone RGBA32F test in this same context (after first frame)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        gl.getExtension('EXT_color_buffer_float');
        const td = new Float32Array([5,6,7,0, 1,2,3,0, 9,8,7,0, 0.5,0.5,0.5,1]);
        const tx = gl.createTexture();
        const savedTex = gl.getParameter(gl.TEXTURE_BINDING_2D);

        // Test WITH premultiply (should corrupt on affected drivers)
        gl.bindTexture(gl.TEXTURE_2D, tx);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, 1, 0, gl.RGBA, gl.FLOAT, td);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fb1 = gl.createFramebuffer();
        const savedFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb1);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx, 0);
        const rb1 = new Float32Array(16);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
          gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.FLOAT, rb1);
        }

        // Test WITHOUT premultiply (should work)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, 1, 0, gl.RGBA, gl.FLOAT, td);
        const rb2 = new Float32Array(16);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
          gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.FLOAT, rb2);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, savedFb);
        gl.deleteFramebuffer(fb1);
        gl.deleteTexture(tx);
        gl.bindTexture(gl.TEXTURE_2D, savedTex);

        const premulCorrupts = rb1.subarray(0, 12).every(v => Math.abs(v) < 0.0001);
        const noPremulOk = td.every((v, i) => Math.abs(v - rb2[i]) < 0.001);
        console.log('[DIAG] STANDALONE: premultiply corrupts FLOAT uploads=' + premulCorrupts +
          ', without premultiply OK=' + noPremulOk);
        if (!premulCorrupts) {
          console.log('[DIAG] *** This driver does NOT apply premultiply to TypedArray uploads ***');
          console.log('[DIAG] *** The premultiply fix is irrelevant here — there is a DIFFERENT bug ***');
        }
        if (premulCorrupts && noPremulOk) {
          console.log('[DIAG] Premultiply IS the issue on this driver. If meshes are still invisible,');
          console.log('[DIAG] the fix is not reaching the upload. Check: rm -rf node_modules/.vite');
        }
      }));
    }
    return ctx;
  };
});

console.log('Loading game...');
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);

const canvas = await page.$('canvas');
if (!canvas) { console.log('ERROR: no canvas found'); await browser.close(); process.exit(1); }
const box = await canvas.boundingBox();

// Start game
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.57);
await page.waitForTimeout(1500);
let phase = await page.evaluate(() => (window).__game?.phase);
if (phase !== 'playing') {
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(1000);
}
diag('phase', await page.evaluate(() => (window).__game?.phase));

// Place 2 pieces
for (let i = 0; i < 2; i++) {
  await page.mouse.move(box.x + box.width * (0.4 + i * 0.1), box.y + box.height * 0.4);
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width * (0.4 + i * 0.1), box.y + box.height * 0.4);
  await page.waitForTimeout(2500);
}

diag('placed', await page.evaluate(() => (window).__game?.placed));

// Screenshot
await page.screenshot({ path: 'diag-instanced.png' });
diag('screenshot', 'diag-instanced.png');

await browser.close();
