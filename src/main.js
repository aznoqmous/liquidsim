// https://github.com/loicmagne/webgl2_fluidsim/blob/main/script.js
import { createNoise2D } from "simplex-noise"
import "./style.css"
"use strict"

const ready = ()=> new Promise(res => {
    if(document.body) return res()
    document.addEventListener("DOMContentLoaded", res)
})

const main = async ()=>{
    await ready();

    const parent = document.querySelector("#app")
    const filterValue = 20
    parent.innerHTML += `
        <svg>
        <defs>
            <filter id="goo">
                <feGaussianBlur stdDeviation="${filterValue}" result="filter3"></feGaussianBlur>
                <feColorMatrix mode="matrix" values="
                1 0 0 0 0 
                0 1 0 0 0 
                0 0 1 0 0 
                0 0 0 ${filterValue*2} -${filterValue}" result="filter4"></feColorMatrix>
            </filter>
        </defs>
    </svg>
    `
    const canvas = document.createElement("canvas")
    canvas.style.filter = "url(#goo)"
    parent.append(canvas)

    const gl = canvas.getContext('webgl2')

    gl.getExtension('EXT_color_buffer_float')

    let radius = 1
    let config = {
        "DISPLAY": "dye",
        "DYE_DISSIPATION": 0.996018928294465,
        "DYE_RESOLUTION": 1024,
        "NU": 0.31622776601683794,
        "PRESSURE": 0.7,
        "RADIUS": 0.01,
        "SIM_RESOLUTION": 128,
        "SPEED": 3,
        "SPLAT_FORCE": 20,
        "VELOCITY_DISSIPATION": 0.996018928294465
    }

    let aspect_ratio;
    let sim_width, sim_height;
    let dye_width, dye_height;

    function get_aspect_ratio() {
        return gl.canvas.clientWidth / gl.canvas.clientHeight;
    }

    function get_size(target_size) {
        if (aspect_ratio < 1) return { width: target_size, height: Math.round(target_size / aspect_ratio) };
        else return { width: Math.round(target_size * aspect_ratio), height: target_size };
    }

    function setup_sizes() {
        const w = gl.canvas.clientWidth;
        const h = gl.canvas.clientHeight;

        aspect_ratio = get_aspect_ratio();

        if (gl.canvas.width === w && gl.canvas.height === h) return false;

        gl.canvas.width = w;
        gl.canvas.height = h;

        const sim_size = get_size(config.SIM_RESOLUTION);
        const dye_size = get_size(config.DYE_RESOLUTION);

        sim_width = sim_size.width;
        sim_height = sim_size.height;
        dye_width = dye_size.width;
        dye_height = dye_size.height;

        return true;
    }

    setup_sizes();

    /* GEOMETRY SETUP */

    let full_vao = gl.createVertexArray();

    const POSITION_LOCATION = 0;

    function setup_geometry(vao, position_data, size, type, normalized, stride, offset) {
        gl.bindVertexArray(vao);

        const position_buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, position_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, position_data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(POSITION_LOCATION);
        gl.vertexAttribPointer(POSITION_LOCATION, size, type, normalized, stride, offset);
    }

    const full_pos = new Float32Array([-1, -1, 1, 1, 1, -1, -1, -1, -1, 1, 1, 1,]);
    setup_geometry(full_vao, full_pos, 2, gl.FLOAT, false, 0, 0);

    /* SHADERS SETUP */

    const utility_neightbors = `
struct Neighbors {
  vec4 l;
  vec4 r;
  vec4 t;
  vec4 b;
  vec4 c;
};

Neighbors tex_neighbors(sampler2D tex, ivec2 pos) {
  vec4 b = texelFetch(tex, pos - ivec2(0, 1), 0);
  vec4 t = texelFetch(tex, pos + ivec2(0, 1), 0);
  vec4 l = texelFetch(tex, pos - ivec2(1, 0), 0);
  vec4 r = texelFetch(tex, pos + ivec2(1, 0), 0);
  vec4 c = texelFetch(tex, pos, 0);
  return Neighbors(l, r, t, b, c);
}`

    const base_vs = `#version 300 es
in vec2 a_position;
out vec2 v_position;

void main() {
  v_position = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0, 1);
}`;

    const advection_fs = `#version 300 es
precision highp float;

uniform sampler2D u_v;
uniform sampler2D u_x;
uniform float u_dt;
uniform float u_dissipation;
out vec4 res;

vec4 bilerp(sampler2D tex, vec2 x_norm, vec2 size) {
  vec2 x = x_norm * size - 0.5;
  vec2 fx = fract(x);
  ivec2 ix = ivec2(floor(x));

  vec4 x00 = texelFetch(tex, ix + ivec2(0,0), 0);
  vec4 x01 = texelFetch(tex, ix + ivec2(0,1), 0);
  vec4 x10 = texelFetch(tex, ix + ivec2(1,0), 0);
  vec4 x11 = texelFetch(tex, ix + ivec2(1,1), 0);

  return mix(mix(x00, x10, fx.x), mix(x01, x11, fx.x), fx.y);
}

void main() {
  vec2 size_v = vec2(textureSize(u_v, 0));
  vec2 size_x = vec2(textureSize(u_x, 0));
  vec2 aspect_ratio = vec2(size_x.x / size_x.y, 1.0);
  vec2 normalized_pos = gl_FragCoord.xy / size_x;
  vec2 prev = normalized_pos - u_dt * bilerp(u_v, normalized_pos, size_v).xy / aspect_ratio; 
  res = u_dissipation * bilerp(u_x, prev, size_x);
}`

    const jacobi_fs = `#version 300 es
precision highp float;

uniform sampler2D u_x;
uniform sampler2D u_b;
uniform float u_alpha;
uniform float u_beta;
out vec4 res;

${utility_neightbors}

void main() {
  ivec2 pos = ivec2(gl_FragCoord.xy); 
  Neighbors n = tex_neighbors(u_x, pos);
  vec4 b = texelFetch(u_b, pos, 0);
  res = (n.b + n.t + n.l + n.r + u_alpha * b) / u_beta;
}`

    const subtract_grad_fs = `#version 300 es
precision highp float;

uniform sampler2D u_v;
uniform sampler2D u_p;
out vec4 res;

${utility_neightbors}

void main() {
  ivec2 pos = ivec2(gl_FragCoord.xy); 
  Neighbors n = tex_neighbors(u_p, pos);

  vec4 grad = vec4(n.r.x - n.l.x, n.t.x - n.b.x, 0, 0) / 2.;
  vec4 init_v = texelFetch(u_v, pos, 0);
  res = init_v - grad;
}`

    const div_fs = `#version 300 es
precision highp float;

uniform sampler2D u_x;
out vec4 res;

${utility_neightbors}

void main() {
  ivec2 pos = ivec2(gl_FragCoord.xy); 
  Neighbors n = tex_neighbors(u_x, pos);

  float div = (n.r.x - n.l.x + n.t.y - n.b.y) / 2.;

  res = vec4(div, 0, 0, 1);
}`

    const boundary_fs = `#version 300 es
precision highp float;

in vec2 v_position;
uniform sampler2D u_x;
uniform vec2 u_res;
uniform float u_alpha;
out vec4 res;

void main() {
  vec2 dir = vec2(0, 0);
  dir += vec2(lessThan(v_position, u_res));
  dir -= vec2(greaterThan(v_position, vec2(1.0) - u_res));
  float coef = length(dir) > 0.0 ? u_alpha : 1.0;
  res = coef * texture(u_x, v_position + dir * u_res);
}`;

    const display_fs = `#version 300 es
precision highp float;

in vec2 v_position;
uniform sampler2D u_x;
uniform float u_alpha;
out vec4 res;

void main() {
    vec4 color = texture(u_x, v_position);
    float alpha = color.x * color.y * color.z;
    color = normalize(color);
    res = vec4(color.xyz, alpha);
}`;

    const splat_fs = `#version 300 es
precision highp float;

in vec2 v_position;
uniform sampler2D u_x;
uniform vec2 u_point;
uniform vec3 u_value;
uniform float u_radius;
uniform float u_ratio;
out vec4 res;

void main() {
  vec4 init = texture(u_x, v_position);
  vec2 v = v_position - u_point;
  v.x *= u_ratio;
  vec3 force = exp(-dot(v,v)/u_radius) * u_value;
  res = vec4(init.xyz + force, 1.);
}`;

    function compile_shader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    function compile_program(gl, vs, fs) {
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error(gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            return null;
        }
        return program;
    }

    function compile_uniforms(gl, program) {
        const uniforms = {};
        const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; ++i) {
            const info = gl.getActiveUniform(program, i);
            uniforms[info.name] = gl.getUniformLocation(program, info.name);
        }
        return uniforms;
    }

    function create_program(vs_source, fs_source) {
        const vs = compile_shader(gl, gl.VERTEX_SHADER, vs_source);
        const fs = compile_shader(gl, gl.FRAGMENT_SHADER, fs_source);
        const program = compile_program(gl, vs, fs);
        const uniforms = compile_uniforms(gl, program);

        gl.bindAttribLocation(program, POSITION_LOCATION, "a_position");

        return { program, uniforms };
    }

    const advection_program = create_program(base_vs, advection_fs);
    const jacobi_program = create_program(base_vs, jacobi_fs);
    const subtract_grad_program = create_program(base_vs, subtract_grad_fs);
    const div_program = create_program(base_vs, div_fs);
    const boundary_program = create_program(base_vs, boundary_fs);
    const display_program = create_program(base_vs, display_fs);
    const splat_program = create_program(base_vs, splat_fs);

    /* TARGET TEXTURES / FRAMEBUFFERS SETUP */

    function create_fbo(w, h, internal_format, format, type, filter) {
        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal_format, w, h, 0, format, type, null);

        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

        return {
            tex: texture,
            fb: fb,
            bind: () => {
                gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
                gl.viewport(0, 0, w, h);
            },
            bind_tex: (i) => {
                gl.activeTexture(gl.TEXTURE0+i);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                return i;
            },
        };
    }

    function create_fbo_pair(w, h, internal_format, format, type, filter) {
        return {
            read: create_fbo(w, h, internal_format, format, type, filter),
            write: create_fbo(w, h, internal_format, format, type, filter),
            swap: function() {
                const temp = this.read;
                this.read = this.write;
                this.write = temp;
            },
        };
    }

    function resize_fbo(src, w, h, internal_format, format, type, filter) {
        const new_fbo = create_fbo(w, h, internal_format, format, type, filter);
        gl.useProgram(display_program.program);
        gl.uniform1i(display_program.uniforms.u_x, src.bind_tex(0));
        render(new_fbo, gl.TRIANGLES, 6);
        return new_fbo;
    }

    function resize_fbo_pair(src, w, h, internal_format, format, type, filter) {
        const new_fbo = create_fbo_pair(w, h, internal_format, format, type, filter);
        new_fbo.read = resize_fbo(src.read, w, h, internal_format, format, type, filter);
        new_fbo.write = resize_fbo(src.write, w, h, internal_format, format, type, filter);
        return new_fbo;
    }

    let velocity = create_fbo_pair(sim_width, sim_height, gl.RG32F, gl.RG, gl.FLOAT, gl.NEAREST);
    let pressure = create_fbo_pair(sim_width, sim_height, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST);
    let tmp_1f = create_fbo(sim_width, sim_height, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST);
    let tmp_2f = create_fbo(sim_width, sim_height, gl.RG32F, gl.RG, gl.FLOAT, gl.NEAREST);
    let dye = create_fbo_pair(dye_width, dye_height, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);

    const screen = {
        tex: null,
        fb: null,
        bind: () => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        }
    }

    function setup_fbos() {
        velocity = resize_fbo_pair(velocity, sim_width, sim_height, gl.RG32F, gl.RG, gl.FLOAT, gl.NEAREST);
        pressure = resize_fbo_pair(pressure, sim_width, sim_height, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST);
        dye = resize_fbo_pair(dye, dye_width, dye_height, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
        tmp_1f = create_fbo(sim_width, sim_height, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST);
        tmp_2f = create_fbo(sim_width, sim_height, gl.RG32F, gl.RG, gl.FLOAT, gl.NEAREST);
    }

    /* SIMULATION / RENDERING */

    function render(fbo, geometry, count, clear = false) {
        gl.bindVertexArray(full_vao);
        fbo.bind();
        if (clear) {
            gl.clearColor(1.0,1.0,1.0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.drawArrays(geometry, 0, count);
    }

    function render_screen(fbo) {
        gl.useProgram(display_program.program);
        gl.uniform1i(display_program.uniforms.u_x, fbo.bind_tex(0));
        gl.uniform1f(display_program.uniforms.u_alpha, 1.0);
        render(screen, gl.TRIANGLES, 6, true);
    }

    function set_boundary(fbo_pair, alpha) {
        gl.useProgram(boundary_program.program);
        gl.uniform2f(boundary_program.uniforms.u_res, 1. / sim_width, 1. / sim_height)
        gl.uniform1i(boundary_program.uniforms.u_x, fbo_pair.read.bind_tex(0));
        gl.uniform1f(boundary_program.uniforms.u_alpha, alpha);
        render(fbo_pair.write, gl.TRIANGLES, 6);
        fbo_pair.swap();
    }

    function step_sim(dt) {

        // Advect velocity
        set_boundary(velocity, -1.0);
        gl.useProgram(advection_program.program);

        gl.uniform1i(advection_program.uniforms.u_v, 0);
        gl.uniform1i(advection_program.uniforms.u_x, velocity.read.bind_tex(0));
        gl.uniform1f(advection_program.uniforms.u_dt, dt);
        gl.uniform1f(advection_program.uniforms.u_dissipation, config.VELOCITY_DISSIPATION);

        render(velocity.write, gl.TRIANGLES, 6);
        velocity.swap();

        // Advect dye
        set_boundary(dye, 0.);
        gl.useProgram(advection_program.program);

        gl.uniform1i(advection_program.uniforms.u_v, velocity.read.bind_tex(0));
        gl.uniform1i(advection_program.uniforms.u_x, dye.read.bind_tex(1));
        gl.uniform1f(advection_program.uniforms.u_dt, dt);
        gl.uniform1f(advection_program.uniforms.u_dissipation, config.DYE_DISSIPATION);

        render(dye.write, gl.TRIANGLES, 6);
        dye.swap();

        // Diffuse velocity
        set_boundary(velocity, -1.0);
        gl.useProgram(jacobi_program.program);

        const factor = 1./ (config.NU * dt);
        gl.uniform1f(jacobi_program.uniforms.u_alpha, factor);
        gl.uniform1f(jacobi_program.uniforms.u_beta, factor + 4.0);
        for (let i = 0; i < 20; i++) {
            gl.uniform1i(jacobi_program.uniforms.u_x, velocity.read.bind_tex(0));
            gl.uniform1i(jacobi_program.uniforms.u_b, velocity.read.bind_tex(0));
            render(velocity.write, gl.TRIANGLES, 6);
            velocity.swap();
        }

        // Project velocity
        // Compute divergence
        set_boundary(velocity, -1);
        gl.useProgram(div_program.program);
        gl.uniform1i(div_program.uniforms.u_x, velocity.read.bind_tex(0));
        render(tmp_1f, gl.TRIANGLES, 6);

        // Clear pressure
        gl.useProgram(display_program.program);
        gl.uniform1i(display_program.uniforms.u_x, pressure.read.bind_tex(0));
        gl.uniform1f(display_program.uniforms.u_alpha, config.PRESSURE);
        render(pressure.write, gl.TRIANGLES, 6);
        pressure.swap();

        // Solve for pressure
        for (let i = 0; i < 50; i++) {
            set_boundary(pressure, 1.);

            // Jacobi iteration
            gl.useProgram(jacobi_program.program);
            gl.uniform1i(jacobi_program.uniforms.u_b, tmp_1f.bind_tex(0));
            gl.uniform1i(jacobi_program.uniforms.u_x, pressure.read.bind_tex(1));
            gl.uniform1f(jacobi_program.uniforms.u_alpha, -1.0);
            gl.uniform1f(jacobi_program.uniforms.u_beta, 4.0);
            render(pressure.write, gl.TRIANGLES, 6);
            pressure.swap();
        }

        // Compute pressure gradient and subtract from velocity
        set_boundary(velocity, -1.);
        set_boundary(pressure, 1.);
        gl.useProgram(subtract_grad_program.program);
        gl.uniform1i(subtract_grad_program.uniforms.u_p, pressure.read.bind_tex(0));
        gl.uniform1i(subtract_grad_program.uniforms.u_v, velocity.read.bind_tex(1));
        render(velocity.write, gl.TRIANGLES, 6);
        velocity.swap();
    }

    let last_time = 0;
    function loop(t) {
        let dt = (t - last_time) / 1000.;
        last_time = t;

        if (setup_sizes()) setup_fbos();
        step_user(pointer.data)
        if(pointer.mouseData) step_user(pointer.mouseData)
        step_sim(dt);
        render_screen(
            config.DISPLAY == 'velocity' ? velocity.read :
                config.DISPLAY == 'pressure' ? pressure.read :
                    dye.read
        );

        requestAnimationFrame(loop);
    }

    requestAnimationFrame(loop);

    function create_pointer(pointer) {
        return {
            id: pointer.pointerId,
            x: pointer.offsetX / gl.canvas.clientWidth,
            y: 1. - pointer.offsetY / gl.canvas.clientHeight,
            dx: 0,
            dy: 0,
            color: [Math.random(), Math.random(), Math.random()]
        };
    }

    let delta = 0
    let lastFrame = 0
    const deltaReq = ()=>{
        delta = (lastFrame - performance.now()) / 1000
        lastFrame = performance.now()
        requestAnimationFrame(deltaReq)
    }
    const lerp = (a,b,t)=>{
        return a*(1-t) + b * t
    }

    class Pointer {
        constructor(){
            this.colors = [
                [247/255, 148/255, 29/255],
                [236/255, 0/255, 140/255],
                [0/255, 184/255, 241/255],
            ]
            this.colors = this.colors.map(color => color.map(value => value/1.5))
            this.colorIndex = Math.random() * this.colors.length
            this.data = create_pointer({
                offsetX: gl.canvas.width/2,
                offsetY: gl.canvas.height/2
            })
            this.noise = createNoise2D()
            this.lastFrame = 0
            this.delta = 0

            this.mouseX = 0.5
            this.mouseY = 0.5

            this.seedX = Math.sin(Math.random() * 2 * Math.PI) * 100
            this.seedY = Math.sin(Math.random() * 2 * Math.PI) * 100
            this.innerRadius = 0.2
            this.bind()
        }

        bind(){
            this.mouseRatio = 0
            canvas.addEventListener('pointermove', (e) => {
                this.mouseX = e.offsetX / gl.canvas.width
                this.mouseY = 1 - e.offsetY / gl.canvas.height
                this.moveLastTime = this.time
                this.mouseRatio += this.delta
                this.mouseRatio = Math.min(this.mouseRatio, 1)
            });
            canvas.addEventListener('pointerleave', ()=>{
                this.mouseX = 0.5
                this.mouseY = 0.5
            })
        }

        getColor(){
            const index = Math.floor(this.colorIndex)
            const currentColor = this.colors[index % this.colors.length]
            const nextColor = this.colors[(index + 1) % this.colors.length]
            const ratio = this.colorIndex % 1
            return currentColor
            // return [
            //     lerp(currentColor[0], nextColor[0], ratio),
            //     lerp(currentColor[1], nextColor[1], ratio),
            //     lerp(currentColor[2], nextColor[2], ratio),
            // ]
        }

        update(){

            const startDuration = 5
            const time = Math.min((performance.now() / 1000) / startDuration, 1)

            const speed = lerp(config.SPEED, config.SPEED, time)
            if(time >= 1){
                this.innerRadius = lerp(this.innerRadius, 0.5, this.delta)
            }

            this.data.x = ((Math.sin(this.seedX + this.time * speed * 0.7) * this.innerRadius + 1) / 2)
            this.data.y = ((Math.cos(this.seedY + this.time * speed) * this.innerRadius + 1) / 2)

            this.mouseRatio -= this.delta / 10
            this.mouseRatio = Math.max(0, this.mouseRatio)
            if(time < 1) this.mouseRatio = 0

            // this.data.x = lerp(this.data.x, this.mouseX, this.mouseRatio)
            // this.data.y = lerp(this.data.y, this.mouseY, this.mouseRatio)

            let startRadius = 1 + 1 / (1 - time + 0.1)
            if(time >= 1) startRadius = 1
            radius = lerp(1.5, 2, this.mouseRatio)

            this.data.dx = (this.data.x - 0.5) / 1000
            this.data.dy = (this.data.y - 0.5) / 1000

            this.colorIndex += this.delta * speed
            this.data.color = this.getColor()

            this.mouseData = {
                x: this.mouseX,
                y: this.mouseY,
                dx: (this.mouseX - 0.5) / 10000,
                dy: (this.mouseY - 0.5) / 10000,
                color: this.data.color
            }

            config.DYE_DISSIPATION = (Math.sin(this.time / 2 * 2 * Math.PI) + 1) / 2 / 200 + 0.99
            config.DYE_DISSIPATION = lerp(config.DYE_DISSIPATION, 0.999, this.mouseRatio / 2)


        }

        live(){
            this.time = performance.now() / 1000
            this.delta = (performance.now() - this.lastFrame) / 1000
            this.lastFrame = performance.now()
            this.update()
            requestAnimationFrame(this.live.bind(this))
        }
    }

    const currentPointer = create_pointer({
        offsetX: gl.canvas.width / 2,
        offsetY: gl.canvas.height / 2,
    })
    const pointer = new Pointer(currentPointer)
    pointer.live()

    step_user(pointer.data)
    if(pointer.mouseData) step_user(pointer.mouseData)

    function step_user(p) {
        if(!p) return;
        gl.useProgram(splat_program.program);
        gl.uniform1i(splat_program.uniforms.u_x, velocity.read.bind_tex(0));
        gl.uniform2fv(splat_program.uniforms.u_point, [p.x, p.y]);
        gl.uniform3fv(splat_program.uniforms.u_value, [p.dx * aspect_ratio, p.dy, 0].map(c => c * config.SPLAT_FORCE));
        gl.uniform1f(splat_program.uniforms.u_radius, config.RADIUS * radius);
        gl.uniform1f(splat_program.uniforms.u_ratio, aspect_ratio);
        render(velocity.write, gl.TRIANGLES, 6);
        velocity.swap();

        gl.uniform1i(splat_program.uniforms.u_x, dye.read.bind_tex(0));
        gl.uniform3fv(splat_program.uniforms.u_value, p.color.map(c => c * 0.1));
        render(dye.write, gl.TRIANGLES, 6);
        dye.swap();
    }

// Transform a 0-1 slider value to an a-b log scale
    function log_scale(value, a, b) {
        return a * Math.pow(b/a, value);
    }

    const viscosity_transform = value => log_scale(value, 0.0001, 1000.);
    const radius_transform = value => log_scale(value, 0.0001, 0.01);
    const velocity_dissipation_transform = value => 1. - log_scale(value, 0.001, 0.1);
    const density_dissipation_transform = value => 1. - log_scale(value, 0.001, 0.1);

    if(!document.querySelector('.settings')) return;

    config.NU = viscosity_transform(0.5);
    config.PRESSURE = 0.7;
    config.RADIUS = radius_transform(1);
    config.VELOCITY_DISSIPATION = velocity_dissipation_transform(0.1);
    config.DYE_DISSIPATION = density_dissipation_transform(0.1);

    const gooFilter = document.getElementById("goo")
    const gooGaussianBlur = gooFilter.querySelector('feGaussianBlur')
    const gooColorMatrix = gooFilter.querySelector('feColorMatrix')
    const setGooValue = (value)=>{
        gooGaussianBlur.setAttribute("stdDeviation", value)
        gooColorMatrix.setAttribute("values", `1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 ${value * 2} ${-value}`)
        document.body.append(gooFilter)
        console.log(config)
    }
    bind("#gooPower", (value)=> setGooValue(value))
    setGooValue(document.querySelector("#gooPower").value)

    bind("#density", (value)=>{
        config.DYE_DISSIPATION = density_dissipation_transform(value)
    })

    bind("#velocity", (value)=>{
        config.VELOCITY_DISSIPATION = velocity_dissipation_transform(value)
    })
    bind("#speed", (value)=>{
        config.SPEED = value * 10
    })

    bind("#pressure", (value)=> config.PRESSURE = value)
}
const bind = (selector, callback)=> document.querySelector(selector).addEventListener('input', (e)=> callback(e.target.value))

main()