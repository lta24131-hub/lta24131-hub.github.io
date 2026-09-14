"use client";

import {
  Box,
  Download,
  FolderOpen,
  Expand,
  Maximize2,
  Moon,
  Orbit,
  Palette,
  PanelsTopLeft,
  RefreshCw,
  RotateCw,
  Sun,
  TriangleAlert,
  X,
} from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { loadLocalStep } from "@/lib/local-step";
import { buildStructureLines } from "@/lib/structure-lines";
import { useModelFullscreen } from "@/lib/use-model-fullscreen";

type MaterialPresetKey = "standard" | "matte" | "metal" | "gloss";
type UpAxis = "x" | "y" | "z" | "custom";
type BackgroundMode = "dark" | "light";
const LARGE_STEP_THRESHOLD = 35 * 1024 * 1024;
const QUARTER_TURNS = (["x", "y", "z"] as const).flatMap((axis) => ([-1, 1] as const).map((direction) => ({ axis, direction })));

const MATERIAL_PRESETS: Record<MaterialPresetKey, { label: string; metalness: number; roughness: number; envMapIntensity: number }> = {
  standard: { label: "标准", metalness: 0.08, roughness: 0.5, envMapIntensity: 1 },
  matte: { label: "哑光", metalness: 0, roughness: 0.88, envMapIntensity: 0.72 },
  metal: { label: "金属", metalness: 0.9, roughness: 0.26, envMapIntensity: 1.45 },
  gloss: { label: "高光", metalness: 0.12, roughness: 0.12, envMapIntensity: 1.2 },
};

const DEFAULT_MODEL_COLOR = "#60666D";
const COLOR_SWATCHES = [
  { color: DEFAULT_MODEL_COLOR, label: "中性灰" },
  { color: "#454B52", label: "石墨灰" },
  { color: "#7B8188", label: "柔和灰" },
  { color: "#536779", label: "灰蓝" },
  { color: "#586C62", label: "灰绿" },
  { color: "#796B5E", label: "暖灰" },
  { color: "#75606A", label: "灰紫" },
  { color: "#70ADD6", label: "浅蓝" },
  { color: "#D7DEE5", label: "银白" },
  { color: "#F2A65A", label: "橙色" },
  { color: "#E85D68", label: "红色" },
  { color: "#54B887", label: "绿色" },
  { color: "#735DD0", label: "紫色" },
];

function readableSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function makeMaterial(color: string, presetKey: MaterialPresetKey, wireframe: boolean) {
  const preset = MATERIAL_PRESETS[presetKey];
  return new THREE.MeshStandardMaterial({
    color,
    metalness: preset.metalness,
    roughness: preset.roughness,
    envMapIntensity: preset.envMapIntensity,
    side: THREE.DoubleSide,
    wireframe,
  });
}

function updateStructureLines(model: THREE.Group, visible: boolean, modelColor: string) {
  const baseColor = new THREE.Color(modelColor);
  const brightness = baseColor.r * 0.299 + baseColor.g * 0.587 + baseColor.b * 0.114;
  const lineColor = brightness < 0.055 ? 0xaab3bd : 0x20262d;

  model.traverse((object) => {
    if (object instanceof THREE.LineSegments && object.userData.structureLines) {
      object.visible = visible;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (material instanceof THREE.LineBasicMaterial) material.color.setHex(lineColor);
      });
    }
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      if (!(material instanceof THREE.MeshStandardMaterial)) return;
      material.polygonOffset = visible;
      material.polygonOffsetFactor = visible ? 1 : 0;
      material.polygonOffsetUnits = visible ? 1 : 0;
      material.needsUpdate = true;
    });
  });
}

async function cacheForOffline(registration: ServiceWorkerRegistration) {
  // Hydration can run before its own entry script has a Resource Timing entry.
  // Waiting for load and reading script/link URLs avoids a falsely ready cache.
  if (document.readyState !== "complete") {
    await new Promise<void>((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
  }
  const urls = new Set<string>([
    location.origin + "/",
    location.origin + "/manifest.webmanifest",
    location.origin + "/favicon.svg",
    location.origin + "/apple-touch-icon.png",
    location.origin + "/icon-192.png",
    location.origin + "/icon-512.png",
    location.origin + "/step-worker.js",
    location.origin + "/step-worker.js?v=14",
    location.origin + "/step-split-worker.js?v=14",
    location.origin + "/step-partition.js?v=14",
    location.origin + "/structure-worker.js?v=15",
    location.origin + "/occt/occt-import-js.js",
    location.origin + "/occt/occt-import-js.wasm",
  ]);

  for (const entry of performance.getEntriesByType("resource")) {
    const url = new URL(entry.name, location.href);
    if (url.origin === location.origin && !url.pathname.startsWith("/api/")) urls.add(url.href);
  }
  for (const element of document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel="modulepreload"], link[rel="stylesheet"]')) {
    const url = new URL(element instanceof HTMLScriptElement ? element.src : element.href, location.href);
    if (url.origin === location.origin && !url.pathname.startsWith("/api/")) urls.add(url.href);
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
  const localAbortRef = useRef<AbortController | null>(null);
  const edgesAbortRef = useRef<AbortController | null>(null);
  const appearanceRef = useRef({ modelColor: DEFAULT_MODEL_COLOR, structureLines: false });
  const fullscreenRef = useRef(false);
  const autoFitRef = useRef(true);
  const invalidateRef = useRef<() => void>(() => {});
  const [offlineState, setOfflineState] = useState<"preparing" | "ready" | "failed">("preparing");
  const [loading, setLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("正在读取文件");
  const [loadingNote, setLoadingNote] = useState("大文件可能需要一点时间");
  const [loadingProgress, setLoadingProgress] = useState<number | null>(null);
  const [canStopLocalLoad, setCanStopLocalLoad] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [modelInfo, setModelInfo] = useState<{ name: string; size: string; meshes: number; partial?: boolean } | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [orientationOpen, setOrientationOpen] = useState(false);
  const [modelColor, setModelColor] = useState(DEFAULT_MODEL_COLOR);
  const [materialPreset, setMaterialPreset] = useState<MaterialPresetKey>("standard");
  const [structureLines, setStructureLines] = useState(false);
  const [edgeProgress, setEdgeProgress] = useState<number | null>(null);
  const [upAxis, setUpAxis] = useState<UpAxis>("y");
  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>("dark");
  const { fullscreen, enter: enterFullscreen, leave: leaveFullscreen } = useModelFullscreen(stageRef);
  appearanceRef.current = { modelColor, structureLines };
  fullscreenRef.current = fullscreen;

  const fitView = useCallback(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const model = modelRef.current;
    if (!camera || !controls || !model) return;

    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty() || ![...box.min, ...box.max].every(Number.isFinite)) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z, 1);
    const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
    const distance = Math.max(size.length() / 2, 1) / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)) * 1.1;

    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(0.82, 0.62, 1).normalize().multiplyScalar(distance));
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
      grid.visible = !fullscreenRef.current;
    }
    invalidateRef.current();
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
    renderer.toneMappingExposure = 0.9;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnvironment = new RoomEnvironment();
    const environment = pmremGenerator.fromScene(roomEnvironment, 0.04).texture;
    roomEnvironment.dispose();
    pmremGenerator.dispose();
    scene.environment = environment;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    controlsRef.current = controls;
    controls.addEventListener("start", () => {
      autoFitRef.current = false;
    });

    const hemisphere = new THREE.HemisphereLight(0xf0f2f5, 0x252931, 1.6);
    scene.add(hemisphere);
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(7, 10, 8);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xc7d0dc, 1.2);
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
      invalidateRef.current();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let frame = 0;
    const render = () => {
      frame = 0;
      controls.update();
      renderer.render(scene, camera);
    };
    const invalidate = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    invalidateRef.current = invalidate;
    controls.addEventListener("change", invalidate);
    invalidate();

    return () => {
      cancelAnimationFrame(frame);
      invalidateRef.current = () => {};
      observer.disconnect();
      controls.dispose();
      environment.dispose();
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
        await navigator.serviceWorker.ready;
        await cacheForOffline(registration);
        if (!cancelled) setOfflineState("ready");
      } catch {
        if (!cancelled) setOfflineState("failed");
      }
    };
    void prepare();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => { localAbortRef.current?.abort(); edgesAbortRef.current?.abort(); }, []);

  useEffect(() => {
    if (gridRef.current) gridRef.current.visible = Boolean(modelRef.current) && !fullscreen;
    if (fullscreen) { setAppearanceOpen(false); setOrientationOpen(false); }
    invalidateRef.current();
  }, [fullscreen]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || loading || !structureLines || model.userData.structureLinesReady) return;
    const controller = new AbortController();
    edgesAbortRef.current = controller;
    setEdgeProgress(0);
    void buildStructureLines(model, controller.signal, setEdgeProgress).then(positions => {
      if (controller.signal.aborted || modelRef.current !== model) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.68, depthTest: true, depthWrite: false, toneMapped: false });
      const lines = new THREE.LineSegments(geometry, material);
      lines.name = "结构线";
      lines.renderOrder = 2;
      lines.userData.structureLines = true;
      model.add(lines);
      model.userData.structureLinesReady = true;
      updateStructureLines(model, appearanceRef.current.structureLines, appearanceRef.current.modelColor);
      invalidateRef.current();
    }).catch(error => {
      if (controller.signal.aborted || modelRef.current !== model) return;
      setStructureLines(false);
      setError(error instanceof Error ? error.message : "结构线计算失败，实体模型不受影响。");
    }).finally(() => {
      if (edgesAbortRef.current === controller) { edgesAbortRef.current = null; setEdgeProgress(null); }
    });
    return () => controller.abort();
  }, [structureLines, loading, modelInfo?.name]);

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
    invalidateRef.current();
  }, [wireframe]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    const preset = MATERIAL_PRESETS[materialPreset];
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (!(material instanceof THREE.MeshStandardMaterial)) return;
        material.color.set(modelColor);
        material.metalness = preset.metalness;
        material.roughness = preset.roughness;
        material.envMapIntensity = preset.envMapIntensity;
        material.vertexColors = false;
        material.needsUpdate = true;
      });
    });
    updateStructureLines(model, structureLines, modelColor);
    invalidateRef.current();
  }, [materialPreset, modelColor, structureLines]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
    materials.forEach((material, index) => {
      if (!(material instanceof THREE.LineBasicMaterial)) return;
      material.color.setHex(backgroundMode === "light"
        ? (index === 0 ? 0x4b7793 : 0x9bb2c1)
        : (index === 0 ? 0x4e94bd : 0x24445d));
      material.opacity = backgroundMode === "light" ? 0.34 : 0.2;
      material.needsUpdate = true;
    });
    invalidateRef.current();
  }, [backgroundMode]);

  const disposeModel = (model: THREE.Group) => {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.LineSegments)) return;
      geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      objectMaterials.forEach((material) => materials.add(material));
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    model.clear();
  };

  const closeModel = () => {
    edgesAbortRef.current?.abort();
    leaveFullscreen();
    localAbortRef.current?.abort();
    setCanStopLocalLoad(false);
    const scene = sceneRef.current;
    const model = modelRef.current;
    if (scene && model) {
      scene.remove(model);
      disposeModel(model);
    }
    modelRef.current = null;
    if (gridRef.current) gridRef.current.visible = false;
    setModelInfo(null);
    setAppearanceOpen(false);
    setOrientationOpen(false);
    setUpAxis("y");
    setError("");
    invalidateRef.current();
  };

  const setModelUpAxis = (axis: Exclude<UpAxis, "custom">) => {
    const model = modelRef.current;
    if (!model) return;
    if (axis === "x") model.rotation.set(0, 0, Math.PI / 2);
    if (axis === "y") model.rotation.set(0, 0, 0);
    if (axis === "z") model.rotation.set(-Math.PI / 2, 0, 0);
    model.updateMatrixWorld(true);
    setUpAxis(axis);
    window.requestAnimationFrame(fitView);
  };

  const rotateModelByQuarter = (axis: "x" | "y" | "z", direction: -1 | 1) => {
    const model = modelRef.current;
    if (!model) return;
    const rotationAxis = axis === "x"
      ? new THREE.Vector3(1, 0, 0)
      : axis === "y"
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
    const rotation = new THREE.Quaternion().setFromAxisAngle(rotationAxis, direction * Math.PI / 2);
    model.quaternion.premultiply(rotation);
    model.updateMatrixWorld(true);
    setUpAxis("custom");
    window.requestAnimationFrame(fitView);
  };


  const exportLightweightModel = async () => {
    const model = modelRef.current;
    if (!model || !modelInfo || exporting || edgeProgress !== null) return;

    const hiddenLines: THREE.LineSegments[] = [];
    setExporting(true);
    setError("");

    try {
      model.traverse((object) => {
        if (object instanceof THREE.LineSegments && object.userData.structureLines === true && object.visible) {
          hiddenLines.push(object);
          object.visible = false;
        }
      });

      const exported = await new GLTFExporter().parseAsync(model, {
        binary: true,
        onlyVisible: true,
      });
      if (!(exported instanceof ArrayBuffer)) throw new Error("轻量文件生成失败。");

      const blob = new Blob([exported], { type: "model/gltf-binary" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const baseName = modelInfo.name.replace(/\.[^.]+$/, "") || "模型";
      link.href = url;
      link.download = `${baseName}-轻量版.glb`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "轻量文件生成失败。";
      setError(message);
    } finally {
      hiddenLines.forEach((line) => { line.visible = true; });
      setExporting(false);
      invalidateRef.current();
    }
  };

  const openFileLocally = async (file: File) => {
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["stp", "step", "stl", "obj", "glb", "3mf"].includes(extension)) {
      setError("请选择 STEP、STP、STL、OBJ、GLB 或 3MF 文件。");
      return;
    }

    edgesAbortRef.current?.abort();
    setError("");
    setLoading(true);
    const isStep = extension === "stp" || extension === "step";
    const isLargeStep = isStep && file.size >= LARGE_STEP_THRESHOLD;
    if (isLargeStep) {
      setStructureLines(false);
      setWireframe(false);
    }
    setLoadingStatus("正在读取文件");
    setLoadingNote("边读边显示，文件只在本机处理，不会上传");
    setLoadingProgress(null);
    const controller = new AbortController();
    localAbortRef.current = controller;
    setCanStopLocalLoad(true);
    autoFitRef.current = true;
    const group = new THREE.Group();
    group.name = file.name;
    let meshCount = 0;
    await new Promise((resolve) => window.setTimeout(resolve, 60));

    try {
      const scene = sceneRef.current;
      if (!scene) throw new Error("三维视图还没有准备好。");

      if (modelRef.current) {
        scene.remove(modelRef.current);
        disposeModel(modelRef.current);
        modelRef.current = null;
        setModelInfo(null);
        if (gridRef.current) gridRef.current.visible = false;
        invalidateRef.current();
      }

      const materialFor = () => makeMaterial(modelColor, materialPreset, wireframe);

      if (isStep) {
        const material = makeMaterial(modelColor, materialPreset, isLargeStep ? false : wireframe);
        try {
          await loadLocalStep(file, controller.signal, (data) => {
            const positions = new Float32Array(data.positions);
            const indices = data.indexType === "uint16" ? new Uint16Array(data.indices) : new Uint32Array(data.indices);
            if (positions.length < 9 || positions.length % 3 || indices.length < 3 || indices.length % 3) throw new Error("解析结果缺少有效曲面。");
            for (const value of positions) if (!Number.isFinite(value)) throw new Error("解析结果包含无效坐标。");
            for (const index of indices) if (index >= positions.length / 3) throw new Error("解析结果包含无效面索引。");
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
            geometry.setIndex(new THREE.BufferAttribute(indices, 1));
            if (data.normals && data.normals.byteLength === data.positions.byteLength) {
              geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(data.normals), 3));
            } else geometry.computeVertexNormals();
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = data.name || "STEP 曲面";
            geometry.computeBoundingBox();
            group.add(mesh);
            meshCount++;
            invalidateRef.current();
            if (meshCount === 1) {
              scene.add(group);
              modelRef.current = group;
              setUpAxis("y");
              setModelInfo({ name: file.name, size: readableSize(file.size), meshes: meshCount, partial: true });
              fitView();
            }
          }, (status, progress, batchDone) => {
            setLoadingStatus(status);
            setLoadingProgress(progress);
            if (batchDone) {
              setModelInfo({ name: file.name, size: readableSize(file.size), meshes: meshCount, partial: true });
              if (autoFitRef.current) fitView();
            }
          });
        } finally { if (!meshCount) material.dispose(); }
      } else if (extension === "stl") {
        const buffer = await file.arrayBuffer();
        const geometry = new STLLoader().parse(buffer);
        if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, materialFor());
        mesh.name = file.name;
        group.add(mesh);
        meshCount = 1;
      } else if (extension === "obj") {
        const buffer = await file.arrayBuffer();
        const imported = new OBJLoader().parse(new TextDecoder().decode(buffer));
        imported.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          meshCount += 1;
          if (!object.geometry.getAttribute("normal")) object.geometry.computeVertexNormals();
          const originalMaterials = Array.isArray(object.material) ? object.material : [object.material];
          originalMaterials.forEach((material) => material.dispose());
          object.material = materialFor();
        });
        if (!meshCount) throw new Error("这个 OBJ 文件没有可显示的三维网格。");
        group.add(imported);
      } else if (extension === "glb") {
        const buffer = await file.arrayBuffer();
        const imported = (await new GLTFLoader().parseAsync(buffer, "")).scene;
        imported.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          meshCount += 1;
          if (!object.geometry.getAttribute("normal")) object.geometry.computeVertexNormals();
          const originalMaterials = Array.isArray(object.material) ? object.material : [object.material];
          originalMaterials.forEach((material) => material.dispose());
          object.material = materialFor();
        });
        if (!meshCount) throw new Error("这个 GLB 文件没有可显示的三维网格。");
        group.add(imported);
      } else {
        const buffer = await file.arrayBuffer();
        const imported = new ThreeMFLoader().parse(buffer);
        imported.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          meshCount += 1;
          if (!object.geometry.getAttribute("normal")) object.geometry.computeVertexNormals();
          const originalMaterials = Array.isArray(object.material) ? object.material : [object.material];
          originalMaterials.forEach((material) => material.dispose());
          object.material = materialFor();
        });
        if (!meshCount) throw new Error("这个 3MF 文件没有可显示的三维网格。");
        group.add(imported);
      }

      updateStructureLines(group, isLargeStep ? false : structureLines, modelColor);
      scene.add(group);
      modelRef.current = group;
      setUpAxis("y");
      setOrientationOpen(false);
      setModelInfo({ name: file.name, size: readableSize(file.size), meshes: meshCount });
      invalidateRef.current();
      if (autoFitRef.current) window.setTimeout(fitView, 0);
    } catch (caught) {
      controller.abort();
      const wasCancelled = caught instanceof DOMException && caught.name === "AbortError";
      const message = caught instanceof Error ? caught.message : "文件读取失败，请换一个模型文件重试。";
      if (modelRef.current === group && meshCount) {
        setModelInfo({ name: file.name, size: readableSize(file.size), meshes: meshCount, partial: true });
        setError(wasCancelled ? "已停止读取。当前仅显示已加载的部分，不是完整模型。" : `模型未完整读取，已保留能显示的部分。${message}`);
      } else if (!wasCancelled) {
        disposeModel(group);
        setError(`${message} 文件没有上传。`);
      }
    } finally {
      if (localAbortRef.current === controller) {
        localAbortRef.current = null;
        setCanStopLocalLoad(false);
      }
      setLoading(false);
      setLoadingProgress(null);
    }
  };

  const handleFilePicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["stp", "step", "stl", "obj", "glb", "3mf"].includes(extension)) {
      setError("请选择 STEP、STP、STL、OBJ、GLB 或 3MF 文件。");
      return;
    }

    await openFileLocally(file);
  };

  const offlineLabel = offlineState === "ready" ? "离线可用" : offlineState === "preparing" ? "准备离线功能" : "需联网重试";
  const stepStillLoading = loading && modelInfo?.partial === true;

  return (
    <main className={`app-shell ${backgroundMode === "light" ? "light-background" : "dark-background"} ${fullscreen ? "model-only" : ""}`}>
      <header className="topbar">
        <div className="brand" aria-label="3D 离线看图">
          <span className="brand-mark"><Box aria-hidden="true" /></span>
          <span>3D 看图</span>
        </div>
        <div className="header-actions">
          <button className="header-open" type="button" onClick={() => fileInputRef.current?.click()} disabled={loading}>
            <FolderOpen aria-hidden="true" />
            <span>打开</span>
          </button>
          <div className={`offline-pill ${offlineState}`} aria-live="polite">
            {offlineState === "preparing" ? <RefreshCw className="mini-spinner" aria-hidden="true" /> : <span className="status-dot" aria-hidden="true" />}
            <span>{offlineLabel}</span>
          </div>
        </div>
        <input ref={fileInputRef} className="hidden-input" type="file" onChange={handleFilePicked} />
      </header>

      <section ref={stageRef} className="viewer-stage" aria-label="三维模型查看区域">
        <div className="technical-grid" aria-hidden="true" />
        <div ref={canvasHostRef} className="canvas-host" />
        {fullscreen && <button className="fullscreen-close" type="button" onClick={leaveFullscreen} aria-label="退出全屏" title="退出全屏" autoFocus><X aria-hidden="true" /></button>}

        <div className="tool-rail" aria-label="视图工具">
          <button type="button" onClick={enterFullscreen} disabled={!modelInfo || loading} aria-label="全屏查看模型" title="全屏查看模型">
            <Expand aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setBackgroundMode((value) => value === "dark" ? "light" : "dark")}
            className={backgroundMode === "light" ? "active" : ""}
            aria-label={backgroundMode === "dark" ? "切换为浅色背景" : "切换为深色背景"}
            title={backgroundMode === "dark" ? "浅色背景" : "深色背景"}
          >
            {backgroundMode === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </button>
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
          <button
            type="button"
            onClick={() => setAppearanceOpen((value) => {
              const next = !value;
              if (next) setOrientationOpen(false);
              return next;
            })}
            disabled={!modelInfo}
            className={appearanceOpen ? "active" : ""}
            aria-pressed={appearanceOpen}
            aria-expanded={appearanceOpen}
            aria-label="调整颜色和材质"
            title="颜色和材质"
          >
            <Palette aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setOrientationOpen((value) => {
              const next = !value;
              if (next) setAppearanceOpen(false);
              return next;
            })}
            disabled={!modelInfo}
            className={orientationOpen ? "active" : ""}
            aria-pressed={orientationOpen}
            aria-expanded={orientationOpen}
            aria-label="调整模型方向和坐标轴"
            title="模型方向"
          >
            <RotateCw aria-hidden="true" />
          </button>
        </div>

        {modelInfo && appearanceOpen && (
          <aside className="appearance-panel" aria-label="颜色和材质">
            <div className="appearance-heading">
              <strong>模型外观</strong>
              <button type="button" onClick={() => setAppearanceOpen(false)} aria-label="关闭外观面板">×</button>
            </div>

            <div className="appearance-section">
              <div className="appearance-label">
                <span>整体颜色</span>
                <span>{modelColor.toUpperCase()}</span>
              </div>
              <div className="color-controls">
                <label className="color-picker" title="自定义颜色">
                  <input
                    type="color"
                    value={modelColor}
                    onChange={(event) => setModelColor(event.target.value.toUpperCase())}
                    aria-label="自定义模型颜色"
                  />
                  <Palette aria-hidden="true" />
                </label>
                {COLOR_SWATCHES.map(({ color, label }) => (
                  <button
                    key={color}
                    className={`color-swatch ${modelColor === color ? "selected" : ""}`}
                    type="button"
                    style={{ backgroundColor: color }}
                    onClick={() => setModelColor(color)}
                    aria-label={`切换模型颜色为${label}`}
                    title={label}
                    aria-pressed={modelColor === color}
                  />
                ))}
              </div>
            </div>

            <div className="appearance-section">
              <div className="appearance-label"><span>材质效果</span></div>
              <div className="material-grid">
                {(Object.entries(MATERIAL_PRESETS) as [MaterialPresetKey, (typeof MATERIAL_PRESETS)[MaterialPresetKey]][]).map(([key, preset]) => (
                  <button
                    key={key}
                    className={materialPreset === key ? "selected" : ""}
                    type="button"
                    onClick={() => setMaterialPreset(key)}
                    aria-pressed={materialPreset === key}
                  >
                    <span className={`material-ball ${key}`} aria-hidden="true" />
                    <span>{preset.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="appearance-section structure-option">
              <div>
                <strong>显示结构线</strong>
                <span role="status">{stepStillLoading ? "读取完成后可开启" : edgeProgress !== null ? `正在整理结构线 ${edgeProgress}%` : "轮廓与折角 · 可叠加在任意材质上"}</span>
              </div>
              <button
                className={structureLines ? "enabled" : ""}
                type="button"
                onClick={() => setStructureLines((value) => !value)}
                disabled={stepStillLoading}
                role="switch"
                aria-checked={structureLines}
                aria-label="显示结构线"
              >
                <span />
              </button>
            </div>

            <button className="export-light-button" type="button" onClick={exportLightweightModel} disabled={exporting || edgeProgress !== null}>
              <Download aria-hidden="true" />
              <span>
                <strong>{exporting ? "正在生成轻量版" : "保存轻量 GLB"}</strong>
                <small>以后在手机上可以快速打开</small>
              </span>
            </button>
          </aside>
        )}

        {modelInfo && orientationOpen && (
          <aside className="orientation-panel" aria-label="模型方向和坐标轴">
            <div className="appearance-heading">
              <strong>模型方向</strong>
              <button type="button" onClick={() => setOrientationOpen(false)} aria-label="关闭方向面板">×</button>
            </div>

            <div className="orientation-section">
              <div className="appearance-label">
                <span>图纸中哪根轴朝上</span>
                <span>{upAxis === "custom" ? "已微调" : `${upAxis.toUpperCase()} 轴`}</span>
              </div>
              <div className="axis-presets">
                {(["x", "y", "z"] as const).map((axis) => (
                  <button
                    key={axis}
                    type="button"
                    className={upAxis === axis ? "selected" : ""}
                    onClick={() => setModelUpAxis(axis)}
                    aria-pressed={upAxis === axis}
                  >
                    <span className={`axis-badge ${axis}`}>{axis.toUpperCase()}</span>
                    <span>轴朝上</span>
                  </button>
                ))}
              </div>
              <p>模型躺倒时，CAD 图纸通常选择 Z 轴朝上。</p>
            </div>

            <div className="orientation-section">
              <div className="appearance-label"><span>每次旋转 90°</span></div>
              <div className="quarter-turns">
                {QUARTER_TURNS.map(({ axis, direction }) => (
                  <button key={`${axis}-${direction}`} type="button" onClick={() => rotateModelByQuarter(axis, direction)}>
                    <span className={`axis-letter ${axis}`}>{axis.toUpperCase()}</span>
                    <span>{direction === -1 ? "−90°" : "+90°"}</span>
                  </button>
                ))}
              </div>
            </div>

            <button className="reset-orientation" type="button" onClick={() => setModelUpAxis("y")}>
              恢复原方向
            </button>
          </aside>
        )}

        {!modelInfo && !loading && (
          <div className="empty-state">
            <span className="empty-icon"><Orbit aria-hidden="true" /></span>
            <h1>打开一个三维模型</h1>
            <p>支持 STEP、STP、STL、OBJ、GLB 和 3MF。选择后自动边读边显示，全程本地处理。</p>
            <button className="open-button" type="button" onClick={() => fileInputRef.current?.click()}>
              <FolderOpen aria-hidden="true" />
              选择文件
            </button>
          </div>
        )}

        {loading && (
          <div className={`loading-card ${modelInfo ? "progressive-loading" : ""}`} role="status" aria-live="polite">
            <span className="loader" />
            <strong>{loadingStatus}</strong>
            <span className="loading-note">{loadingNote}</span>
            {loadingProgress !== null && (
              <div className="loading-progress" aria-label={`进度 ${loadingProgress}%`}>
                <span style={{ width: `${loadingProgress}%` }} />
              </div>
            )}
            {canStopLocalLoad && <button className="stop-loading" type="button" onClick={() => localAbortRef.current?.abort()}>停止读取{modelInfo ? "，保留已显示部分" : ""}</button>}
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
            <div>
              <strong title={modelInfo.name}>{modelInfo.name}</strong>
              <span>{modelInfo.meshes} 个网格 · {modelInfo.size}{modelInfo.partial ? " · 尚未完整" : ""}</span>
            </div>
            <button type="button" onClick={closeModel} aria-label="关闭当前模型" title="关闭当前模型">
              <X aria-hidden="true" />
            </button>
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
