import math
import os
import sys

import bpy
from mathutils import Vector


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(arguments) != 2:
    fail("Usage: blender --background --python keep_visible_parts.py -- parts-directory output.glb")

parts_directory = os.path.abspath(arguments[0])
output_path = os.path.abspath(arguments[1])
part_files = sorted(
    os.path.join(parts_directory, name)
    for name in os.listdir(parts_directory)
    if name.lower().endswith(".stl")
)
if not part_files:
    fail("No part meshes were generated.")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

for part_path in part_files:
    before = set(bpy.data.objects)
    if hasattr(bpy.ops.wm, "stl_import"):
        bpy.ops.wm.stl_import(filepath=part_path)
    else:
        bpy.ops.import_mesh.stl(filepath=part_path)
    imported = list(set(bpy.data.objects) - before)
    for item in imported:
        item.name = os.path.splitext(os.path.basename(part_path))[0]

objects = [item for item in bpy.context.scene.objects if item.type == "MESH" and len(item.data.polygons)]
if not objects:
    fail("No mesh objects were imported.")

world_corners = []
for item in objects:
    world_corners.extend(item.matrix_world @ Vector(corner) for corner in item.bound_box)
minimum = Vector((
    min(point.x for point in world_corners),
    min(point.y for point in world_corners),
    min(point.z for point in world_corners),
))
maximum = Vector((
    max(point.x for point in world_corners),
    max(point.y for point in world_corners),
    max(point.z for point in world_corners),
))
center = (minimum + maximum) * 0.5
dimensions = maximum - minimum
radius = max(dimensions.length * 0.62, 1.0)

# Cast about 1.3 million rays from 54 directions. An object is retained if any
# ray reaches it first, which removes fully enclosed parts while preserving
# pieces visible through openings and recesses.
directions = [
    Vector((1, 0, 0)), Vector((-1, 0, 0)),
    Vector((0, 1, 0)), Vector((0, -1, 0)),
    Vector((0, 0, 1)), Vector((0, 0, -1)),
]
golden_angle = math.pi * (3.0 - math.sqrt(5.0))
for index in range(48):
    y = 1.0 - 2.0 * (index + 0.5) / 48.0
    radial = math.sqrt(max(0.0, 1.0 - y * y))
    angle = index * golden_angle
    directions.append(Vector((math.cos(angle) * radial, y, math.sin(angle) * radial)))

scene = bpy.context.scene
depsgraph = bpy.context.evaluated_depsgraph_get()
visible_names = set()
grid_resolution = 156
span = radius * 1.15
ray_distance = radius * 4.5

for direction in directions:
    direction.normalize()
    helper = Vector((0, 0, 1)) if abs(direction.z) < 0.9 else Vector((0, 1, 0))
    horizontal = direction.cross(helper).normalized()
    vertical = horizontal.cross(direction).normalized()
    start_center = center + direction * radius * 2.1
    for row in range(grid_resolution):
        v = ((row + 0.5) / grid_resolution - 0.5) * 2.0 * span
        for column in range(grid_resolution):
            u = ((column + 0.5) / grid_resolution - 0.5) * 2.0 * span
            origin = start_center + horizontal * u + vertical * v
            hit, _, _, _, hit_object, _ = scene.ray_cast(
                depsgraph, origin, -direction, distance=ray_distance
            )
            if hit and hit_object is not None:
                visible_names.add(hit_object.original.name if hasattr(hit_object, "original") else hit_object.name)

if not visible_names:
    fail("External visibility scan did not find any model parts.")

hidden_count = 0
for item in list(objects):
    if item.name not in visible_names:
        bpy.data.objects.remove(item, do_unlink=True)
        hidden_count += 1

kept = [item for item in bpy.context.scene.objects if item.type == "MESH" and len(item.data.polygons)]
if not kept:
    fail("All model parts were removed during external visibility filtering.")

# Merge the retained exterior components and limit triangle count for smooth
# interaction on iPhone. Geometry stays in full 3D, unlike a screenshot.
bpy.ops.object.select_all(action="DESELECT")
for item in kept:
    item.select_set(True)
bpy.context.view_layer.objects.active = kept[0]
bpy.ops.object.join()
model = bpy.context.active_object
model.name = "外观模型"

triangle_count = len(model.data.polygons)
target_triangles = 650000
if triangle_count > target_triangles:
    modifier = model.modifiers.new(name="手机轻量化", type="DECIMATE")
    modifier.ratio = max(0.05, target_triangles / float(triangle_count))
    modifier.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = model
    bpy.ops.object.modifier_apply(modifier=modifier.name)

material = bpy.data.materials.new(name="标准材质")
material.diffuse_color = (0.162, 0.418, 0.665, 1.0)
model.data.materials.clear()
model.data.materials.append(material)

bpy.ops.object.select_all(action="DESELECT")
model.select_set(True)
bpy.context.view_layer.objects.active = model
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_materials="EXPORT",
    export_yup=True,
)
print("Kept %d visible parts, removed %d fully hidden parts" % (len(kept), hidden_count))
