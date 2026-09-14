"use client";

import {
  Box,
  CloudUpload,
  Download,
  FolderOpen,
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

type MaterialPresetKey = "standard" | "matte" | "metal" | "gloss";
type UpAxis = "x" | "y" | "z" | "custom";
type BackgroundMode = "dark" | "light";
type CloudJobState = "uploading" | "queued" | "converting" | "ready" | "failed";

type PendingCloudJob = {
  id: string;
  fileName: string;
  size: number;
  taskToken?: string;
  accessKey?: string;
};

type CloudStatus = {
  id: string;
  fileName: string;
  size: number;
  state: CloudJobState;
  progress: number;
  message: string;
  resultSize?: number;
};

const LARGE_STEP_THRESHOLD = 35 * 1024 * 1024;
const CLOUD_SITE_ORIGIN = "https://step-viewer-offline-0914.design53648.chatgpt.site";
const PENDING_CLOUD_JOB_KEY = "step-viewer-pending-cloud-job";
const CLOUD_ACCESS_KEY_STORAGE = "step-viewer-cloud-access-key";
const QUARTER_TURNS = (["x", "y", "z"] as const).flatMap((axis) => ([-1, 1] as const).map((direction) => ({ axis, direction })));

const MATERIAL_PRESETS: Record<MaterialPresetKey, { label: string; metalness: number; roughness: number; envMapIntensity: number }> = {
  standard: { label: "标准", metalness: 0.08, roughness: 0.5, envMapIntensity: 1 },
  matte: { label: "哑光", metalness: 0, roughness: 0.88, envMapIntensity: 0.72 },
  metal: { label: "金属", metalness: 0.9, roughness: 0.26, envMapIntensity: 1.45 },
  gloss: { label: "高光", metalness: 0.12, roughness: 0.12, envMapIntensity: 1.2 },
};

const COLOR_SWATCHES = ["#70ADD6", "#D7DEE5", "#F2A65A", "#E85D68", "#54B887", "#735DD0"];

function readableSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isValidPendingCloudJob(value: PendingCloudJob) {
  return Boolean(
    value &&
    /^[0-9a-f-]{36}$/i.test(value.id) &&
    typeof value.fileName === "string" &&
    Number.isFinite(value.size) &&
    ((typeof value.taskToken === "string" && value.taskToken.length >= 64) ||
      (typeof value.accessKey === "string" && value.accessKey.length > 0))
  );
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
  const lineColor = brightness < 0.3 ? 0xe9f7ff : 0x0a1824;

  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;

    let lines = object.children.find((child) => child.userData.structureLines === true) as THREE.LineSegments | undefined;
    if (visible && !lines) {
      const geometry = new THREE.EdgesGeometry(object.geometry, 18);
      const material = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.82 });
      lines = new THREE.LineSegments(geometry, material);
      lines.name = "结构线";
      lines.renderOrder = 2;
      lines.userData.structureLines = true;
      object.add(lines);
    }

    if (lines) {
      lines.visible = visible;
      const materials = Array.isArray(lines.material) ? lines.material : [lines.material];
      materials.forEach((material) => {
        if (material instanceof THREE.LineBasicMaterial) material.color.setHex(lineColor);
      });
    }

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
  const urls = new Set<string>([
    location.origin + "/",
    location.origin + "/manifest.webmanifest",
    location.origin + "/favicon.svg",
    location.origin + "/apple-touch-icon.png",
    location.origin + "/icon-192.png",
    location.origin + "/icon-512.png",
    location.origin + "/step-worker.js",
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
  const stepWorkerRef = useRef<Worker | null>(null);
  const largeFileDecisionRef = useRef(false);
  const [offlineState, setOfflineState] = useState<"preparing" | "ready" | "failed">("preparing");
  const [loading, setLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("正在读取文件");
  const [loadingNote, setLoadingNote] = useState("大文件可能需要一点时间");
  const [loadingProgress, setLoadingProgress] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [modelInfo, setModelInfo] = useState<{ name: string; size: string; meshes: number } | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [orientationOpen, setOrientationOpen] = useState(false);
  const [modelColor, setModelColor] = useState("#70ADD6");
  const [materialPreset, setMaterialPreset] = useState<MaterialPresetKey>("standard");
  const [structureLines, setStructureLines] = useState(false);
  const [upAxis, setUpAxis] = useState<UpAxis>("y");
  const [cloudCandidate, setCloudCandidate] = useState<File | null>(null);
  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>("dark");

  useEffect(() => {
    const parameters = new URLSearchParams(location.hash.replace(/^#/, ""));
    const activationKey = parameters.get("activate")?.trim();
    if (!activationKey) return;
    if (/^[A-Za-z0-9_-]{12,128}$/.test(activationKey)) {
      localStorage.setItem(CLOUD_ACCESS_KEY_STORAGE, activationKey);
    }
    parameters.delete("activate");
    const remainingHash = parameters.toString();
    history.replaceState(history.state, "", `${location.pathname}${location.search}${remainingHash ? `#${remainingHash}` : ""}`);
  }, []);

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

  useEffect(() => () => stepWorkerRef.current?.terminate(), []);

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
  }, [backgroundMode]);

  const disposeModel = (model: THREE.Group) => {
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.LineSegments)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
  };

  const closeModel = () => {
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

  const readStepFile = (
    file: File,
    group: THREE.Group,
    materialFor: () => THREE.MeshStandardMaterial,
  ) => new Promise<number>((resolve, reject) => {
    const worker = new Worker("/step-worker.js");
    stepWorkerRef.current = worker;
    let meshCount = 0;
    let lastProgressUpdate = 0;

    const finish = () => {
      worker.terminate();
      if (stepWorkerRef.current === worker) stepWorkerRef.current = null;
    };

    worker.onmessage = (message) => {
      const data = message.data;

      if (data?.type === "status") {
        if (data.phase === "starting") setLoadingStatus("正在启动 STEP 解析器");
        if (data.phase === "parsing") setLoadingStatus("正在解析模型");
        return;
      }

      if (data?.type === "start") {
        setLoadingStatus(`正在处理 0 / ${data.total} 个部件`);
        return;
      }

      if (data?.type === "mesh") {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(data.positions), 3));
        if (data.normals) {
          geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(data.normals), 3));
        } else {
          geometry.computeVertexNormals();
        }
        const indices = data.indexType === "uint16" ? new Uint16Array(data.indices) : new Uint32Array(data.indices);
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

        const mesh = new THREE.Mesh(geometry, materialFor());
        mesh.name = data.name || "STEP 部件";
        group.add(mesh);
        meshCount += 1;

        const now = performance.now();
        if (now - lastProgressUpdate > 120 || meshCount === data.total) {
          lastProgressUpdate = now;
          setLoadingStatus(`正在处理 ${meshCount} / ${data.total} 个部件`);
        }
        return;
      }

      if (data?.type === "done") {
        finish();
        resolve(meshCount);
        return;
      }

      if (data?.type === "error") {
        finish();
        reject(new Error(data.message || "STEP 文件读取失败。"));
      }
    };

    worker.onerror = () => {
      finish();
      reject(new Error("STEP 解析意外中断。这个文件可能超过了手机浏览器可用内存。"));
    };

    const megabytes = file.size / 1024 / 1024;
    const params = megabytes > 120
      ? { linearDeflection: 0.012, angularDeflection: 0.9 }
      : megabytes > 60
        ? { linearDeflection: 0.007, angularDeflection: 0.75 }
        : megabytes > 30
          ? { linearDeflection: 0.0035, angularDeflection: 0.6 }
          : { linearDeflection: 0.0015, angularDeflection: 0.5 };

    worker.postMessage({
      type: "parse",
      file,
      params: {
        linearUnit: "millimeter",
        linearDeflectionType: "bounding_box_ratio",
        ...params,
      },
    });
  });

  const cloudApiOrigin = () => location.hostname.endsWith("github.io") ? CLOUD_SITE_ORIGIN : location.origin;

  const cloudRequest = async (path: string, credentialHeader: "X-Conversion-Key" | "X-Task-Token", credential: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set(credentialHeader, credential);
    const response = await fetch(`${cloudApiOrigin()}${path}`, { ...init, headers, cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
      if (body.code === "access_key") localStorage.removeItem(CLOUD_ACCESS_KEY_STORAGE);
      throw new Error(body.error || `云端处理失败（${response.status}）。`);
    }
    return response;
  };

  const cloudAccessFetch = (path: string, accessKey: string, init?: RequestInit) =>
    cloudRequest(path, "X-Conversion-Key", accessKey, init);

  const cloudTaskFetch = (path: string, job: PendingCloudJob, init?: RequestInit) => {
    if (job.taskToken) return cloudRequest(path, "X-Task-Token", job.taskToken, init);
    return cloudRequest(path, "X-Conversion-Key", job.accessKey ?? "", init);
  };

  const showCloudResult = async (buffer: ArrayBuffer, job: PendingCloudJob) => {
    const scene = sceneRef.current;
    if (!scene) throw new Error("三维视图还没有准备好。");

    const imported = (await new GLTFLoader().parseAsync(buffer, "")).scene;
    const group = new THREE.Group();
    group.name = job.fileName;
    let meshCount = 0;
    imported.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshCount += 1;
      if (!object.geometry.getAttribute("normal")) object.geometry.computeVertexNormals();
      const originalMaterials = Array.isArray(object.material) ? object.material : [object.material];
      originalMaterials.forEach((material) => material.dispose());
      object.material = makeMaterial(modelColor, materialPreset, wireframe);
    });
    if (!meshCount) throw new Error("云端生成的模型没有可显示的外观网格。");
    group.add(imported);

    if (modelRef.current) {
      scene.remove(modelRef.current);
      disposeModel(modelRef.current);
    }
    updateStructureLines(group, structureLines, modelColor);
    scene.add(group);
    modelRef.current = group;
    setUpAxis("y");
    setOrientationOpen(false);
    setModelInfo({ name: job.fileName, size: readableSize(job.size), meshes: meshCount });
    window.setTimeout(fitView, 0);
  };

  const waitForCloudConversion = async (job: PendingCloudJob) => {
    const deadline = Date.now() + 45 * 60 * 1000;
    while (Date.now() < deadline) {
      const statusResponse = await cloudTaskFetch(`/api/convert/status/${job.id}`, job);
      const status = await statusResponse.json() as CloudStatus;
      setLoadingStatus(status.message || "正在云端转换");
      setLoadingProgress(Math.min(97, 62 + Math.round(Math.max(0, status.progress) * 0.35)));
      setLoadingNote("已自动删除内部看不到的部件，完成后原始图纸会从云端删除");

      if (status.state === "failed") throw new Error(status.message || "云端转换没有完成，请重新选择文件再试。");
      if (status.state === "ready") {
        setLoadingStatus("正在下载轻量模型");
        setLoadingProgress(98);
        const result = await cloudTaskFetch(`/api/convert/result/${job.id}`, job);
        const buffer = await result.arrayBuffer();
        setLoadingStatus("正在打开外观模型");
        setLoadingProgress(99);
        await showCloudResult(buffer, job);
        localStorage.removeItem(PENDING_CLOUD_JOB_KEY);
        void cloudTaskFetch(`/api/convert/task/${job.id}`, job, { method: "DELETE" }).catch(() => undefined);
        setLoadingProgress(100);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
    }
    throw new Error("云端转换等待超时。任务仍在继续，重新打开网站会自动接着等待。");
  };

  const startCloudConversion = async (file: File) => {
    const accessKey = localStorage.getItem(CLOUD_ACCESS_KEY_STORAGE)?.trim() || "";
    if (!accessKey) {
      setError("这台设备还没有启用云端快速处理，请用专用链接重新打开网站一次。");
      return;
    }

    setError("");
    setLoading(true);
    setLoadingStatus("正在建立安全上传");
    setLoadingNote("图纸会临时上传，只用于生成手机外观模型");
    setLoadingProgress(0);
    let taskId = "";
    let queued = false;
    let pendingJob: PendingCloudJob | null = null;

    try {
      const createResponse = await cloudAccessFetch("/api/convert/create", accessKey, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, size: file.size }),
      });
      const task = await createResponse.json() as { id: string; uploadId: string; partSize: number; taskToken: string };
      taskId = task.id;
      if (!task.taskToken) throw new Error("云端任务权限创建失败，请稍后重试。");
      pendingJob = { id: task.id, fileName: file.name, size: file.size, taskToken: task.taskToken };
      const partCount = Math.ceil(file.size / task.partSize);
      const parts: Array<{ partNumber: number; etag: string }> = [];
      let nextPart = 1;
      let uploadedBytes = 0;

      const uploadWorker = async () => {
        while (true) {
          const partNumber = nextPart++;
          if (partNumber > partCount) return;
          const start = (partNumber - 1) * task.partSize;
          const end = Math.min(start + task.partSize, file.size);
          const response = await cloudTaskFetch(`/api/convert/upload/${task.id}/${partNumber}?uploadId=${encodeURIComponent(task.uploadId)}`, pendingJob!, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: file.slice(start, end),
          });
          const uploadedPart = await response.json() as { partNumber: number; etag: string };
          parts.push(uploadedPart);
          uploadedBytes += end - start;
          const percent = Math.min(60, Math.round(uploadedBytes / file.size * 60));
          setLoadingStatus(`正在上传图纸 ${Math.round(uploadedBytes / file.size * 100)}%`);
          setLoadingProgress(percent);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, partCount) }, () => uploadWorker()));

      setLoadingStatus("上传完成，正在启动云端转换");
      setLoadingProgress(61);
      await cloudTaskFetch(`/api/convert/complete/${task.id}`, pendingJob, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: task.uploadId, parts }),
      });
      queued = true;
      localStorage.setItem(PENDING_CLOUD_JOB_KEY, JSON.stringify(pendingJob));
      await waitForCloudConversion(pendingJob);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "云端处理失败，请稍后重试。";
      setError(message);
      if (!queued && taskId) {
        const cleanup = pendingJob
          ? cloudTaskFetch(`/api/convert/task/${taskId}`, pendingJob, { method: "DELETE" })
          : cloudAccessFetch(`/api/convert/task/${taskId}`, accessKey, { method: "DELETE" });
        void cleanup.catch(() => undefined);
      }
    } finally {
      setLoading(false);
      setLoadingProgress(null);
    }
  };

  const exportLightweightModel = async () => {
    const model = modelRef.current;
    if (!model || !modelInfo || exporting) return;

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
    }
  };

  const openFileLocally = async (file: File) => {
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!extension || !["stp", "step", "stl", "obj", "glb", "3mf"].includes(extension)) {
      setError("请选择 STEP、STP、STL、OBJ、GLB 或 3MF 文件。");
      return;
    }

    setError("");
    setLoading(true);
    setLoadingStatus("正在读取文件");
    setLoadingNote("文件只在本机处理，不会上传");
    setLoadingProgress(null);
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
      }

      const group = new THREE.Group();
      group.name = file.name;
      let meshCount = 0;
      const materialFor = () => makeMaterial(modelColor, materialPreset, wireframe);

      if (extension === "stp" || extension === "step") {
        meshCount = await readStepFile(file, group, materialFor);
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

      updateStructureLines(group, structureLines, modelColor);
      scene.add(group);
      modelRef.current = group;
      setUpAxis("y");
      setOrientationOpen(false);
      setModelInfo({ name: file.name, size: readableSize(file.size), meshes: meshCount });
      window.setTimeout(fitView, 0);
    } catch (caught) {
      stepWorkerRef.current?.terminate();
      stepWorkerRef.current = null;
      const message = caught instanceof Error ? caught.message : "文件读取失败，请换一个模型文件重试。";
      const isLargeLocalStep = (extension === "stp" || extension === "step") && file.size >= LARGE_STEP_THRESHOLD;
      if (isLargeLocalStep) {
        setError(`手机没有成功打开这个大文件，文件没有上传。你可以在下方改用云端快速打开。${message ? `（${message}）` : ""}`);
        setCloudCandidate(file);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
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

    if ((extension === "stp" || extension === "step") && file.size >= LARGE_STEP_THRESHOLD) {
      setCloudCandidate(file);
      return;
    }

    await openFileLocally(file);
  };

  const chooseLargeStepMethod = (method: "local" | "cloud") => {
    if (largeFileDecisionRef.current || !cloudCandidate) return;
    largeFileDecisionRef.current = true;
    const file = cloudCandidate;
    setCloudCandidate(null);
    const task = method === "local" ? openFileLocally(file) : startCloudConversion(file);
    void task.finally(() => {
      largeFileDecisionRef.current = false;
    });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = localStorage.getItem(PENDING_CLOUD_JOB_KEY);
      if (!stored) return;
      try {
        const pending = JSON.parse(stored) as PendingCloudJob;
        if (!isValidPendingCloudJob(pending)) throw new Error("invalid");
        setLoading(true);
        setLoadingStatus("正在恢复云端转换任务");
        setLoadingNote("无需重新上传，转换完成后会自动打开");
        setLoadingProgress(62);
        void waitForCloudConversion(pending)
          .catch((caught) => {
            const message = caught instanceof Error ? caught.message : "无法恢复云端转换任务。";
            setError(message);
            if (/不存在|已过期|无效|没有完成|权限|启用/.test(message)) localStorage.removeItem(PENDING_CLOUD_JOB_KEY);
          })
          .finally(() => {
            setLoading(false);
            setLoadingProgress(null);
          });
      } catch {
        localStorage.removeItem(PENDING_CLOUD_JOB_KEY);
      }
    }, 0);
    return () => window.clearTimeout(timer);
    // This intentionally runs only once to resume a task saved before launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const offlineLabel = offlineState === "ready" ? "离线可用" : offlineState === "preparing" ? "准备离线功能" : "需联网重试";

  return (
    <main className={`app-shell ${backgroundMode === "light" ? "light-background" : "dark-background"}`}>
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

        <div className="tool-rail" aria-label="视图工具">
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
                {COLOR_SWATCHES.map((color) => (
                  <button
                    key={color}
                    className={`color-swatch ${modelColor === color ? "selected" : ""}`}
                    type="button"
                    style={{ backgroundColor: color }}
                    onClick={() => setModelColor(color)}
                    aria-label={`切换模型颜色为 ${color}`}
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
                <span>可叠加在当前材质上</span>
              </div>
              <button
                className={structureLines ? "enabled" : ""}
                type="button"
                onClick={() => setStructureLines((value) => !value)}
                role="switch"
                aria-checked={structureLines}
              >
                <span />
              </button>
            </div>

            <button className="export-light-button" type="button" onClick={exportLightweightModel} disabled={exporting}>
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
            <p>支持 STEP、STP、STL、OBJ、GLB 和 3MF。大型 STEP 可先在手机打开，也可选择云端轻量化。</p>
            <button className="open-button" type="button" onClick={() => fileInputRef.current?.click()}>
              <FolderOpen aria-hidden="true" />
              选择文件
            </button>
          </div>
        )}

        {loading && (
          <div className="loading-card" role="status" aria-live="polite">
            <span className="loader" />
            <strong>{loadingStatus}</strong>
            <span className="loading-note">{loadingNote}</span>
            {loadingProgress !== null && (
              <div className="loading-progress" aria-label={`进度 ${loadingProgress}%`}>
                <span style={{ width: `${loadingProgress}%` }} />
              </div>
            )}
          </div>
        )}

        {cloudCandidate && !loading && (
          <div className="dialog-backdrop" role="presentation">
            <section className="cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-dialog-title">
              <span className="cloud-dialog-icon"><CloudUpload aria-hidden="true" /></span>
              <h2 id="cloud-dialog-title">这个大文件怎么打开？</h2>
              <p className="cloud-file-name" title={cloudCandidate.name}>{cloudCandidate.name}</p>
              <p>这个 STEP 有 {readableSize(cloudCandidate.size)}。你可以先让手机直接尝试，全程不会上传；如果更看重速度，再选择云端快速打开。</p>
              <div className="privacy-note">
                <strong>只有选择云端才会上传</strong>
                <span>云端会删除内部完全看不到的零件；原始图纸在转换完成后删除，轻量模型在手机打开后删除。</span>
              </div>
              <div className="cloud-dialog-actions">
                <button
                  type="button"
                  onClick={() => chooseLargeStepMethod("local")}
                >
                  先在手机打开
                </button>
                <button
                  className="primary"
                  type="button"
                  onClick={() => chooseLargeStepMethod("cloud")}
                >
                  云端快速打开
                </button>
                <button className="cancel" type="button" onClick={() => setCloudCandidate(null)}>取消</button>
              </div>
            </section>
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
              <span>{modelInfo.meshes} 个部件 · {modelInfo.size}</span>
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
