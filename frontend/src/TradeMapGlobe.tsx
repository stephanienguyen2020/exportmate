import { useEffect, useRef, useState } from "react";
import {
  geoDistance,
  geoEquirectangular,
  geoGraticule10,
  geoInterpolate,
  geoPath,
} from "d3-geo";
import type { Feature, Geometry, Polygon } from "geojson";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Minus, Pause, Play, Plus, RotateCcw } from "lucide-react";

export type GlobePoint = {
  key: string;
  at: [number, number];
  label: string;
  aria: string;
  tone: string;
  count: number;
  selected: boolean;
  related: boolean;
  origin?: boolean;
  approximate?: boolean;
  observation?: boolean;
};
export type GlobeRoute = {
  key: string;
  connectionKey?: string;
  from: [number, number];
  to: [number, number];
  tone: string;
  dim: boolean;
  approximate?: boolean;
};
type Props = {
  countries: Feature<Geometry, { name: string }>[];
  countryColors: Map<string, string>;
  points: GlobePoint[];
  routes: GlobeRoute[];
  extents: Polygon[];
  originApproximate?: boolean;
  routeLabel?: string | null;
  onSelect: (key: string) => void;
  onFallback: () => void;
};
const COLORS: Record<string, string> = {
  red: "#ff997c",
  amber: "#f3ce79",
  green: "#c3ed9a",
  neutral: "#dcebc7",
  target: "#ffd17a",
  water: "#94d8ee",
};
// Matches the equirectangular texture's UV coordinates on SphereGeometry.
function position([lon, lat]: [number, number], radius = 1) {
  const phi = THREE.MathUtils.degToRad(lat);
  const theta = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    Math.cos(phi) * Math.cos(theta),
    Math.sin(phi),
    -Math.cos(phi) * Math.sin(theta),
  ).multiplyScalar(radius);
}
function disposeGroup(group: THREE.Group) {
  group.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.Line ||
      object instanceof THREE.Points
    ) {
      object.geometry.dispose();
      (Array.isArray(object.material)
        ? object.material
        : [object.material]
      ).forEach((m) => m.dispose());
    }
  });
  group.clear();
}

export default function TradeMapGlobe(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef(new Map<string, HTMLButtonElement>());
  const latest = useRef(props);
  latest.current = props;
  const [playing, setPlaying] = useState(
    () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const engine = useRef<{
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    earth: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhongMaterial>;
    routes: THREE.Group;
    observations: THREE.Group;
    particles: {
      line: THREE.Points;
      positions: Float32Array;
      path: THREE.Vector3[];
      offset: number;
    }[];
    invalidate: () => void;
  } | null>(null);

  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "low-power",
      });
    } catch {
      latest.current.onFallback();
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.domElement.className = "tm-globe-webgl";
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.setAttribute(
      "aria-label",
      "Globe surface. Use arrow keys to rotate, plus and minus to zoom.",
    );
    element.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    camera.position.copy(position([75, 24], 3.5));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 2.25;
    controls.maxDistance = 5.5;
    controls.autoRotateSpeed = 0.35;
    controls.update();
    controls.saveState();
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 64),
      new THREE.MeshPhongMaterial({
        color: "#ffffff",
        shininess: 12,
        specular: "#305849",
      }),
    );
    scene.add(earth);
    scene.add(new THREE.AmbientLight("#d9eadc", 2.1));
    const light = new THREE.DirectionalLight("#fff4d4", 2.1);
    camera.add(light);
    light.position.set(-2, 3, 4);
    scene.add(camera);
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 64, 48),
      new THREE.ShaderMaterial({
        vertexShader:
          "varying vec3 n; varying vec3 v; void main(){ vec4 p=modelViewMatrix*vec4(position,1.0); n=normalize(normalMatrix*normal); v=normalize(-p.xyz); gl_Position=projectionMatrix*p; }",
        fragmentShader:
          "varying vec3 n; varying vec3 v; void main(){ float rim=pow(clamp(1.0-abs(dot(n,v)),0.0,1.0),3.0); gl_FragColor=vec4(0.55,0.83,0.61,rim*0.35); }",
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    scene.add(atmosphere);
    const routes = new THREE.Group();
    scene.add(routes);
    const observations = new THREE.Group();
    scene.add(observations);
    let frame = 0,
      previous = 0,
      elapsed = 0,
      visible = true,
      dirty = true,
      interacting = false;
    let viewportWidth = 1,
      viewportHeight = 1;
    const invalidate = () => {
      dirty = true;
    };
    const state = {
      camera,
      controls,
      earth,
      routes,
      observations,
      particles: [] as NonNullable<typeof engine.current>["particles"],
      invalidate,
    };
    engine.current = state;
    const observer = new ResizeObserver(([entry]) => {
      viewportWidth = entry.contentRect.width;
      viewportHeight = entry.contentRect.height;
      if (!viewportWidth || !viewportHeight) return;
      renderer.setSize(viewportWidth, viewportHeight);
      camera.aspect = viewportWidth / viewportHeight;
      camera.updateProjectionMatrix();
      invalidate();
    });
    observer.observe(element);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      invalidate();
    });
    intersection.observe(element);
    const start = () => {
      interacting = true;
      setPlaying(false);
      invalidate();
    };
    const end = () => {
      interacting = false;
      invalidate();
    };
    controls.addEventListener("start", start);
    controls.addEventListener("end", end);
    controls.addEventListener("change", invalidate);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const reduce = () => {
      if (reduced.matches) setPlaying(false);
      invalidate();
    };
    reduced.addEventListener("change", reduce);
    const contextLost = (event: Event) => {
      event.preventDefault();
      latest.current.onFallback();
    };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    const keydown = (event: KeyboardEvent) => {
      if (
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "+",
          "=",
          "-",
        ].includes(event.key)
      )
        return;
      event.preventDefault();
      setPlaying(false);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight")
        controls.rotateLeft(event.key === "ArrowLeft" ? 0.12 : -0.12);
      else if (event.key === "ArrowUp" || event.key === "ArrowDown")
        controls.rotateUp(event.key === "ArrowUp" ? 0.12 : -0.12);
      else
        camera.position.setLength(
          THREE.MathUtils.clamp(
            camera.position.length() * (event.key === "-" ? 1.1 : 0.9),
            2.25,
            5.5,
          ),
        );
      controls.update();
      invalidate();
    };
    renderer.domElement.addEventListener("keydown", keydown);
    const screen = new THREE.Vector3();
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const delta = Math.min((now - previous) / 1000 || 0, 0.05);
      previous = now;
      if (!visible || document.hidden) return;
      const moving = playingRef.current && !interacting;
      controls.autoRotate = moving;
      controls.update(delta);
      if (!dirty && !moving) return;
      if (moving) elapsed += delta;
      camera.updateMatrixWorld();
      for (const particle of state.particles) {
        for (let i = 0; i < particle.positions.length / 3; i++) {
          const phase = (elapsed * 0.11 + particle.offset - i * 0.006 + 10) % 1;
          const index = phase * (particle.path.length - 1);
          screen
            .copy(particle.path[Math.floor(index)])
            .lerp(
              particle.path[
                Math.min(Math.floor(index) + 1, particle.path.length - 1)
              ],
              index % 1,
            );
          screen.toArray(particle.positions, i * 3);
        }
        particle.line.geometry.attributes.position.needsUpdate = true;
      }
      const boxes: number[][] = [];
      const placed: [number, number][] = [];
      const ordered = [...latest.current.points].sort(
        (a, b) =>
          Number(b.selected) - Number(a.selected) ||
          Number(b.origin) - Number(a.origin) ||
          b.count - a.count,
      );
      for (const point of ordered) {
        const button = labels.current.get(point.key);
        if (!button) continue;
        const at = position(point.at, 1.014);
        // Hide the far hemisphere using the tangent plane, including at close zoom.
        const facing = at.dot(camera.position) > 1.035;
        screen.copy(at).project(camera);
        const x = ((screen.x + 1) * viewportWidth) / 2;
        const y = ((1 - screen.y) * viewportHeight) / 2;
        const shown =
          facing && Math.abs(screen.x) < 0.94 && Math.abs(screen.y) < 0.85;
        button.style.visibility = shown ? "visible" : "hidden";
        button.tabIndex = shown ? 0 : -1;
        button.dataset.visible = String(shown);
        if (!shown) continue;
        const offset = [
          [0, 0],
          [0, -32],
          [0, 32],
          [-32, 0],
          [32, 0],
          [-32, -32],
          [32, 32],
        ].find(([dx, dy]) =>
          placed.every(
            ([px, py]) => Math.hypot(x + dx - px, y + dy - py) >= 28,
          ),
        ) ?? [0, 0];
        const [dx, dy] = offset;
        placed.push([x + dx, y + dy]);
        button.style.left = `${x + dx}px`;
        button.style.top = `${y + dy}px`;
        button.style.setProperty("--leader-length", `${Math.hypot(dx, dy)}px`);
        button.style.setProperty(
          "--leader-angle",
          `${Math.atan2(-dy, -dx)}rad`,
        );
        const left = x > viewportWidth * 0.7;
        button.dataset.side = left ? "left" : "right";
        const labelWidth = point.label.length * 6.3 + 22;
        const box = [
          left ? x + dx - labelWidth - 22 : x + dx + 22,
          y + dy - 12,
          left ? x + dx - 22 : x + dx + labelWidth + 22,
          y + dy + 12,
        ];
        const overlap = boxes.some(
          (b) =>
            box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3],
        );
        button.dataset.label = String(
          point.selected ||
            (!overlap && box[0] > 8 && box[2] < viewportWidth - 8),
        );
        if (!overlap) boxes.push(box);
      }
      renderer.render(scene, camera);
      dirty = false;
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      reduced.removeEventListener("change", reduce);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      renderer.domElement.removeEventListener("keydown", keydown);
      controls.dispose();
      disposeGroup(routes);
      disposeGroup(observations);
      earth.material.map?.dispose();
      earth.geometry.dispose();
      earth.material.dispose();
      atmosphere.geometry.dispose();
      atmosphere.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      engine.current = null;
    };
  }, []);

  useEffect(() => {
    const state = engine.current;
    if (!state) return;
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 1024;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#173b35";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const projection = geoEquirectangular()
      .scale(canvas.width / (2 * Math.PI))
      .translate([canvas.width / 2, canvas.height / 2]);
    const path = geoPath(projection, context);
    context.beginPath();
    path(geoGraticule10());
    context.strokeStyle = "#264940";
    context.lineWidth = 0.7;
    context.stroke();
    for (const country of props.countries) {
      context.beginPath();
      path(country);
      context.fillStyle =
        props.countryColors.get(String(country.id)) ?? "#769181";
      context.fill();
      context.strokeStyle = "#35564a";
      context.lineWidth = 0.65;
      context.stroke();
    }
    state.earth.material.map?.dispose();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    state.earth.material.map = texture;
    state.earth.material.needsUpdate = true;
    state.invalidate();
  }, [props.countries, props.countryColors]);

  useEffect(() => {
    const state = engine.current;
    if (!state) return;
    disposeGroup(state.routes);
    state.particles = [];
    props.routes.forEach((route, index) => {
      const interpolate = geoInterpolate(route.from, route.to);
      const height = Math.min(
        0.42,
        0.08 + geoDistance(route.from, route.to) * 0.15,
      );
      const path = Array.from({ length: 129 }, (_, i) =>
        position(
          interpolate(i / 128) as [number, number],
          1.012 + Math.sin((Math.PI * i) / 128) * height,
        ),
      );
      const color = COLORS[route.tone] ?? COLORS.green;
      const curve = new THREE.CatmullRomCurve3(path);
      const coreRadius = route.dim ? 0.004 : 0.013;
      const addTube = (radius: number, opacity: number) => {
        const mesh = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 96, radius, 6, false),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity,
            depthWrite: false,
          }),
        );
        mesh.renderOrder = 2;
        state.routes.add(mesh);
      };
      addTube(
        coreRadius * 2.5,
        route.dim ? 0.05 : route.approximate ? 0.18 : 0.3,
      );
      addTube(coreRadius, route.dim ? 0.22 : route.approximate ? 0.75 : 0.95);
      const positions = new Float32Array(9 * 3);
      const colors = new Float32Array(9 * 3);
      for (let i = 0; i < 9; i++)
        new THREE.Color(color)
          .multiplyScalar(1 - i / 11)
          .toArray(colors, i * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const particle = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          size: route.dim ? 0.01 : 0.024,
          vertexColors: true,
          transparent: true,
          opacity: route.dim ? 0.15 : 1,
          depthWrite: false,
        }),
      );
      particle.frustumCulled = false;
      state.routes.add(particle);
      state.particles.push({
        line: particle,
        positions,
        path,
        offset: index * 0.17,
      });
    });
    state.invalidate();
  }, [props.routes]);

  useEffect(() => {
    const state = engine.current;
    if (!state) return;
    disposeGroup(state.observations);
    for (const polygon of props.extents)
      for (const ring of polygon.coordinates) {
        const points = ring.map(([lon, lat]) => position([lon, lat], 1.006));
        state.observations.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: COLORS.water }),
          ),
        );
      }
    state.invalidate();
  }, [props.extents]);

  useEffect(() => {
    engine.current?.invalidate();
  }, [props.points, playing]);
  const zoom = (factor: number) => {
    setPlaying(false);
    const state = engine.current;
    if (!state) return;
    state.camera.position.setLength(
      THREE.MathUtils.clamp(state.camera.position.length() * factor, 2.25, 5.5),
    );
    state.controls.update();
    state.invalidate();
  };
  const connectionCount = new Set(
    props.routes.map((r) => r.connectionKey ?? r.key),
  ).size;
  return (
    <div
      className="tm-globe"
      ref={host}
      role="group"
      aria-label="Interactive 3D trade globe"
      data-playing={playing}
    >
      <div className="tm-globe-caption">
        <span>YOUR WORLD OF TRADE</span>
        <small>Drag to explore · Scroll to zoom</small>
      </div>
      {props.routeLabel && (
        <p className="tm-route-preview" role="status">
          Proposed route · {props.routeLabel}
        </p>
      )}
      <div className="tm-globe-labels">
        {props.points.map((point) => (
          <button
            key={point.key}
            ref={(node) => {
              if (node) labels.current.set(point.key, node);
              else labels.current.delete(point.key);
            }}
            className={`tm-globe-marker ${point.selected ? "selected" : ""} ${point.related ? "" : "dim"} ${point.origin ? "origin" : ""} ${point.approximate ? "approximate" : ""} ${point.observation ? "observation" : ""}`}
            style={
              {
                "--marker-color": COLORS[point.tone] ?? COLORS.green,
              } as React.CSSProperties
            }
            aria-label={point.aria}
            aria-pressed={point.selected}
            onPointerEnter={() => setPlaying(false)}
            onFocus={() => setPlaying(false)}
            onClick={() => {
              setPlaying(false);
              props.onSelect(point.key);
            }}
          >
            <span className="tm-globe-leader" aria-hidden="true" />
            <span className="tm-globe-dot">
              {point.observation ? "≈" : point.count || ""}
            </span>
            <span className="tm-globe-label">{point.label}</span>
          </button>
        ))}
      </div>
      <div
        className="tm-globe-controls"
        role="group"
        aria-label="Globe controls"
      >
        <button
          aria-label={
            playing ? "Pause globe animation" : "Play globe animation"
          }
          aria-pressed={playing}
          onClick={() => setPlaying(!playing)}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button aria-label="Zoom in" onClick={() => zoom(0.88)}>
          <Plus size={16} />
        </button>
        <button aria-label="Zoom out" onClick={() => zoom(1.14)}>
          <Minus size={16} />
        </button>
        <button
          aria-label="Reset globe view"
          onClick={() => {
            engine.current?.controls.reset();
            engine.current?.invalidate();
          }}
        >
          <RotateCcw size={15} />
        </button>
      </div>
      <div className="tm-globe-foot">
        <span>
          <i />{" "}
          {connectionCount === 1
            ? "1 TRADE CONNECTION"
            : `${connectionCount} TRADE CONNECTIONS`}
        </span>
        <small>
          {props.originApproximate
            ? "Profile origin · Not a recorded site · Not vessel tracking"
            : "Illustrative connections · Not vessel tracking"}
        </small>
      </div>
    </div>
  );
}
