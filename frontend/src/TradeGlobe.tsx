import { useEffect, useRef } from "react";
import * as THREE from "three";

// A tiny, genuinely three-dimensional brass-wire globe. No image texture required.
export default function TradeGlobe() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      element.dataset.fallback = "true";
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(100, 100);
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 20);
    camera.position.z = 4.2;
    const globe = new THREE.Group();
    globe.rotation.z = -0.18;
    globe.rotation.y = 0.6;
    scene.add(globe);
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.92, 40, 24),
      new THREE.MeshBasicMaterial({ color: 0xe9e9da }),
    );
    globe.add(sphere);
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x3f6456,
      transparent: true,
      opacity: 0.52,
    });
    for (let lat = -60; lat <= 60; lat += 30) {
      const a = THREE.MathUtils.degToRad(lat),
        r = Math.cos(a) * 0.94,
        y = Math.sin(a) * 0.94;
      globe.add(
        new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(
            Array.from(
              { length: 96 },
              (_, i) =>
                new THREE.Vector3(
                  Math.cos((i / 96) * Math.PI * 2) * r,
                  y,
                  Math.sin((i / 96) * Math.PI * 2) * r,
                ),
            ),
          ),
          lineMaterial,
        ),
      );
    }
    for (let lon = 0; lon < 180; lon += 30) {
      const a = THREE.MathUtils.degToRad(lon);
      globe.add(
        new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(
            Array.from({ length: 96 }, (_, i) => {
              const t = (i / 96) * Math.PI * 2;
              return new THREE.Vector3(
                Math.sin(t) * Math.cos(a) * 0.94,
                Math.cos(t) * 0.94,
                Math.sin(t) * Math.sin(a) * 0.94,
              );
            }),
          ),
          lineMaterial,
        ),
      );
    }
    const point = (lat: number, lon: number, r = 0.955) => {
      const a = (lat * Math.PI) / 180,
        b = (lon * Math.PI) / 180;
      return new THREE.Vector3(
        r * Math.cos(a) * Math.sin(b),
        r * Math.sin(a),
        r * Math.cos(a) * Math.cos(b),
      );
    };
    // Stylized land outlines; decorative, not a geographic data product.
    const continents = [
      [
        [58, -130],
        [70, -98],
        [52, -60],
        [40, -74],
        [24, -81],
        [15, -90],
        [28, -112],
        [48, -126],
        [58, -130],
      ],
      [
        [12, -80],
        [7, -50],
        [-7, -35],
        [-33, -53],
        [-54, -70],
        [-20, -76],
        [12, -80],
      ],
      [
        [35, -10],
        [37, 30],
        [13, 50],
        [-34, 19],
        [-8, 9],
        [6, -15],
        [35, -10],
      ],
      [
        [37, -8],
        [59, 5],
        [70, 34],
        [65, 150],
        [43, 145],
        [22, 120],
        [5, 105],
        [25, 75],
        [38, 45],
        [37, -8],
      ],
      [
        [-11, 115],
        [-14, 141],
        [-38, 151],
        [-33, 116],
        [-11, 115],
      ],
    ];
    const landMaterial = new THREE.LineBasicMaterial({ color: 0x274c3c });
    continents.forEach((shape) => {
      const curve = new THREE.CatmullRomCurve3(
        shape.map(([lat, lon]) => point(lat, lon)),
        false,
        "centripetal",
      );
      const pts = curve
        .getPoints(100)
        .map((v) => v.normalize().multiplyScalar(0.957));
      globe.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          landMaterial,
        ),
      );
    });
    const route = new THREE.QuadraticBezierCurve3(
      point(11, 107),
      point(55, 78, 1.45),
      point(52, 5),
    );
    const routeLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(route.getPoints(60)),
      new THREE.LineBasicMaterial({ color: 0xa3543d }),
    );
    globe.add(routeLine);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.034, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xa3543d }),
    );
    globe.add(dot);
    let dragging = false,
      lastX = 0,
      velocity = 0.002,
      visible = true,
      frame = 0,
      phase = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      element.setPointerCapture(e.pointerId);
      element.classList.add("is-dragging");
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      globe.rotation.y += dx * 0.017;
      velocity = Math.max(-0.02, Math.min(0.02, dx * 0.001));
      lastX = e.clientX;
    };
    const up = () => {
      dragging = false;
      element.classList.remove("is-dragging");
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        globe.rotation.y += e.key === "ArrowLeft" ? -0.2 : 0.2;
        renderer.render(scene, camera);
      }
    };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("keydown", key);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    observer.observe(element);
    dot.position.copy(route.getPoint(0));
    renderer.render(scene, camera);
    let previous = 0;
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      if (!visible || document.hidden) return;
      if (reduced.matches && !dragging) return;
      const delta = Math.min((time - previous) / 16.67, 2) || 1;
      previous = time;
      if (!reduced.matches && !dragging) {
        globe.rotation.y += velocity * delta;
        velocity += (0.002 - velocity) * 0.025;
        phase = (phase + 0.0015 * delta) % 1;
      }
      dot.position.copy(route.getPoint(phase));
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("keydown", key);
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material)
            ? obj.material
            : [obj.material];
          mats.forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div
      className="trade-globe"
      ref={host}
      tabIndex={0}
      role="img"
      aria-label="Interactive 3D trade globe. Drag or use left and right arrow keys to rotate."
    >
      <span className="globe-fallback" aria-hidden="true">
        ◎
      </span>
    </div>
  );
}
