"use client";

import {
  Box,
  FolderOpen,
  Maximize2,
  Orbit,
  PanelsTopLeft,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

type OcctFace = { first: number; last: number; color?: number[] | null };
type OcctMesh = {
  name?: string;
  color?: number[];
  brep_faces?: OcctFace[];
  attributes: {
    position: { array: number[] };
    normal?: { array: number[] };
  };
  index: { array: number[] };
};
type OcctResult = { success: boolean; meshes?: OcctMesh[] };
type OcctApi = {
  ReadStepFile: (content: Uint8Array, params: Record<string, unknown> | null) => OcctResult;
};

declare global {
  interface Window {
    occtimportjs?: () => Promise<OcctApi>;
  }
}

let occtPromise: Promise<OcctApi> | null = null;

function loadOcct() {
  if (occtPromise) return occtPromise;
  occtPromise = new Promise<OcctApi>((resolve, reject) => {
    const begin = () => {
      if (!window.occtimportjs) {
        reject(new Error("STEP 解析器没有正确载入。"));
        return;
      }
      window.occtimportjs().then(resolve).catch(reject);
    };

    if (window.occtimportjs) {
      begin();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>("script[data-occt]");
    if (existing) {
      existing.addEventListener("load", begin, { once: true });
      existing.addEventListener("error", () => reject(new Error("STEP 解析器下载失败。")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "/occt/occt-import-js.js";
    script.async = true;
    script.dataset.occt = "true";
    script.addEventListener("load", begin, { once: true });
    script.addEventListener("error", () => reject(new Error("STEP 解析器下载失败。")), { once: true });
    document.head.appendChild(script);
  });
  return occtPromise;
}

function readableSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function colorKey(color: number[]) {
  return color.slice(0, 3).map((value) => Math.round(value * 255)).join("-");
}

function makeMaterial(color: number[], wireframe: boolean, vertexColors = false) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color[0] ?? 0.58, color[1] ?? 0.72, color[2] ?? 0.82),
    metalness: 0.08,
    roughness: 0.55,
    side: THREE.DoubleSide,
    wireframe,
    vertexColors,
  });
}

async function cacheForOffline(registration: ServiceWorkerRegistration) {
  const urls = new Set<string>([
    location.origin + "/",
    location.origin + "/manifest.webmanifest",
    location.origin + "/favicon.svg",
    location.origin + "/apple-touch-icon.png",
    location.origin + "/icon-192.png",
    location.origin + "/icon-512.png",
    location.origin + "/occt/occt-import-js.js",
    location.origin + "/occt/occt-import-js.wasm",
  ]);

  for (const entry of performance.getEntriesByType("resource")) {
    const url = new URL(entry.name, location.href);
    if (url.origin === location.origin) urls.add(url.href);
  }

  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) throw new Error("离线服务尚未启动，请重新打开页面后再试。");

  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => reject(new Error("离线缓存准备超时。")), 30000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      if (event.data?.ok) resolve();
      else reject(new Error("离线缓存准备失败。"));
    };
    worker.postMessage({ type: "CACHE_URLS", urls: [...urls] }, [channel.port2]);
  });
}

export default function Home() {
  const stageRef = useRef<HTMLElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const [offlineState, setOfflineState] = useState<"preparing" | "ready" | "failed">("preparing");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [modelInfo, setModelInfo] = useState<{ name: string; size: string; meshes: number } | null>(null);
  const [wireframe, setWireframe] = useState(false);

  const fitView = useCallback(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const model = modelRef.current;
    if (!camera || !controls || !model) return;

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z, 1);
    const fitHeightDistance = maxDimension / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
    const distance = fitHeightDistance * 1.45;

    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(distance * 0.82, distance * 0.62, distance));
    camera.near = Math.max(maxDimension / 1000, 0.01);
    camera.far = Math.max(maxDimension * 100, 1000);
    camera.updateProjectionMatrix();
    controls.minDistance = maxDimension * 0.08;
    controls.maxDistance = maxDimension * 30;
    controls.update();

    const grid = gridRef.current;
    if (grid) {
      grid.position.set(center.x, box.min.y, center.z);
      grid.scale.setScalar(Math.max(maxDimension / 10, 0.1));
      grid.visible = true;
    }
  }, []);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000);
    camera.position.set(8, 6, 10);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    controlsRef.current = controls;

    const hemisphere = new THREE.HemisphereLight(0xccecff, 0x17212b, 2.3);
    scene.add(hemisphere);
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
    keyLight.position.set(7, 10, 8);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x54bbff, 2.2);
    rimLight.position.set(-8, 3, -6);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(10, 20, 0x4e94bd, 0x24445d);
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMaterials.forEach((material) => { material.transparent = true; material.opacity = 0.2; });
    grid.visible = false;
    gridRef.current = grid;
    scene.add(grid);

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let frame = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      try {
        if (!("serviceWorker" in navigator)) throw new Error("此浏览器不支持离线应用。请使用 Safari。 ");
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await Promise.all([navigator.serviceWorker.ready, loadOcct()]);
        await cacheForOffline(registration);
        if (!cancelled) setOfflineState("ready");
      } catch {
        if (!cancelled) setOfflineState("failed");
      }
    };
    void prepare();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (material instanceof THREE.MeshStandardMaterial) {
          material.wireframe = wireframe;
          material.needsUpdate = true;
        }
      });
    });
  }, [wireframe]);

  const disposeModel = (model: THREE.Group) => {
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
  };

  const openFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["stp", "step", "stl", "obj"].includes(extension)) {
      setError("请选择 STEP、STP、STL 或 OBJ 文件。");
      return;
    }

    setError("");
    setLoading(true);
    await new Promise((resolve) => window.setTimeout(resolve, 60));

    try {
      const scene = sceneRef.current;
      if (!scene) throw new Error("三维视图还没有准备好。");
      const buffer = await file.arrayBuffer();

      if (modelRef.current) {
        scene.remove(modelRef.current);
        disposeModel(modelRef.current);
      }

      const group = new THREE.Group();
      group.name = file.name;
      let meshCount = 0;
      const materialCache = new Map<string, THREE.MeshStandardMaterial>();
      const materialFor = (color: number[], vertexColors = false) => {
        const key = `${colorKey(color)}-${vertexColors ? "v" : "u"}`;
        let material = materialCache.get(key);
        if (!material) {
          material = makeMaterial(color, wireframe, vertexColors);
          materialCache.set(key, material);
        }
        return material;
      };

      if (extension === "stp" || extension === "step") {
        const occt = await loadOcct();
        const result = occt.ReadStepFile(new Uint8Array(buffer), {
          linearUnit: "millimeter",
          linearDeflectionType: "bounding_box_ratio",
          linearDeflection: file.size > 30 * 1024 * 1024 ? 0.003 : 0.0015,
          angularDeflection: 0.5,
        });

        if (!result.success || !result.meshes?.length) throw new Error("这个文件没有可显示的三维实体。");

        for (const source of result.meshes) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.Float32BufferAttribute(source.attributes.position.array, 3));
          if (source.attributes.normal?.array?.length) {
            geometry.setAttribute("normal", new THREE.Float32BufferAttribute(source.attributes.normal.array, 3));
          } else {
            geometry.computeVertexNormals();
          }
          geometry.setIndex(source.index.array);

          const baseColor = source.color ?? [0.44, 0.68, 0.84];
          const materials: THREE.MeshStandardMaterial[] = [];
          const materialIndices = new Map<string, number>();
          const addMaterial = (color: number[]) => {
            const key = colorKey(color);
            const previous = materialIndices.get(key);
            if (previous !== undefined) return previous;
            const index = materials.length;
            materials.push(materialFor(color));
            materialIndices.set(key, index);
            return index;
          };

          const defaultIndex = addMaterial(baseColor);
          if (source.brep_faces?.length) {
            for (const face of source.brep_faces) {
              const materialIndex = addMaterial(face.color ?? baseColor);
              geometry.addGroup(face.first * 3, (face.last - face.first + 1) * 3, materialIndex);
            }
          } else {
            geometry.addGroup(0, source.index.array.length, defaultIndex);
          }

          const mesh = new THREE.Mesh(geometry, materials);
          mesh.name = source.name ?? "STEP 部件";
          group.add(mesh);
          meshCount += 1;
        }
      } else if (extension === "stl") {
        const geometry = new STLLoader().parse(buffer);
        if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
        const hasVertexColors = Boolean(geometry.getAttribute("color"));
        const mesh = new THREE.Mesh(geometry, materialFor([0.44, 0.68, 0.84], hasVertexColors));
        mesh.name = file.name;
        group.add(mesh);
        meshCount = 1;
      } else {
        const imported = new OBJLoader().parse(new TextDecoder().decode(buffer));
        imported.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          meshCount += 1;
          if (!object.geometry.getAttribute("normal")) object.geometry.computeVertexNormals();
          const originalMaterials = Array.isArray(object.material) ? object.material : [object.material];
          const originalColor = originalMaterials.find((material) => "color" in material)?.color;
          const color = originalColor instanceof THREE.Color
            ? [originalColor.r, originalColor.g, originalColor.b]
            : [0.44, 0.68, 0.84];
          originalMaterials.forEach((material) => material.dispose());
          object.material = materialFor(color, Boolean(object.geometry.getAttribute("color")));
        });
        if (!meshCount) throw new Error("这个 OBJ 文件没有可显示的三维网格。");
        group.add(imported);
      }

      scene.add(group);
      modelRef.current = group;
      setModelInfo({ name: file.name, size: readableSize(file.size), meshes: meshCount });
      window.setTimeout(fitView, 0);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "文件读取失败，请换一个模型文件重试。";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const offlineLabel = offlineState === "ready" ? "离线可用" : offlineState === "preparing" ? "准备离线功能" : "需联网重试";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="3D 离线看图">
          <span className="brand-mark"><Box aria-hidden="true" /></span>
          <span>3D 看图</span>
        </div>
        <div className="header-actions">
          <button className="header-open" type="button" onClick={() => fileInputRef.current?.click()}>
            <FolderOpen aria-hidden="true" />
            <span>打开</span>
          </button>
          <div className={`offline-pill ${offlineState}`} aria-live="polite">
            {offlineState === "preparing" ? <RefreshCw className="mini-spinner" aria-hidden="true" /> : <span className="status-dot" aria-hidden="true" />}
            <span>{offlineLabel}</span>
          </div>
        </div>
        <input ref={fileInputRef} className="hidden-input" type="file" accept=".stp,.step,.stl,.obj" onChange={openFile} />
      </header>

      <section ref={stageRef} className="viewer-stage" aria-label="三维模型查看区域">
        <div className="technical-grid" aria-hidden="true" />
        <div ref={canvasHostRef} className="canvas-host" />

        <div className="tool-rail" aria-label="视图工具">
          <button type="button" onClick={fitView} disabled={!modelInfo} aria-label="适合窗口" title="适合窗口">
            <Maximize2 aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setWireframe((value) => !value)}
            disabled={!modelInfo}
            className={wireframe ? "active" : ""}
            aria-pressed={wireframe}
            aria-label={wireframe ? "切换为实体显示" : "切换为线框显示"}
            title={wireframe ? "实体显示" : "线框显示"}
          >
            <PanelsTopLeft aria-hidden="true" />
          </button>
        </div>

        {!modelInfo && !loading && (
          <div className="empty-state">
            <span className="empty-icon"><Orbit aria-hidden="true" /></span>
            <h1>打开一个三维模型</h1>
            <p>支持 STEP、STP、STL 和 OBJ，文件只在这台设备上处理。</p>
            <button className="open-button" type="button" onClick={() => fileInputRef.current?.click()}>
              <FolderOpen aria-hidden="true" />
              选择文件
            </button>
          </div>
        )}

        {loading && (
          <div className="loading-card" role="status" aria-live="polite">
            <span className="loader" />
            <strong>正在生成三维模型</strong>
            <span>大文件可能需要一点时间</span>
          </div>
        )}

        {error && (
          <div className="error-card" role="alert">
            <TriangleAlert aria-hidden="true" />
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} aria-label="关闭提示">×</button>
          </div>
        )}

        {modelInfo && (
          <div className="model-info">
            <strong title={modelInfo.name}>{modelInfo.name}</strong>
            <span>{modelInfo.meshes} 个部件 · {modelInfo.size}</span>
          </div>
        )}

        <div className="gesture-hint" aria-hidden="true">
          <span>单指旋转</span><i />
          <span>双指缩放</span><i />
          <span>双指拖动</span>
        </div>
      </section>
    </main>
  );
}
