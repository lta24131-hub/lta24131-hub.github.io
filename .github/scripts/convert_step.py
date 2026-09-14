import math
import os
import sys

import FreeCAD
import Import
import Mesh
import MeshPart


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


if len(sys.argv) != 3:
    fail("Usage: freecadcmd convert_step.py input.step output-directory")

source_path = os.path.abspath(sys.argv[1])
output_directory = os.path.abspath(sys.argv[2])
os.makedirs(output_directory, exist_ok=True)
document = FreeCAD.newDocument("MobilePreview")

try:
    Import.insert(source_path, document.Name)
    document.recompute()
    objects = [
        item for item in document.Objects
        if hasattr(item, "Shape") and not item.Shape.isNull()
    ]
    if not objects:
        fail("No displayable solids or surfaces were found in the STEP file.")

    min_x = min(item.Shape.BoundBox.XMin for item in objects)
    min_y = min(item.Shape.BoundBox.YMin for item in objects)
    min_z = min(item.Shape.BoundBox.ZMin for item in objects)
    max_x = max(item.Shape.BoundBox.XMax for item in objects)
    max_y = max(item.Shape.BoundBox.YMax for item in objects)
    max_z = max(item.Shape.BoundBox.ZMax for item in objects)
    diagonal = math.sqrt((max_x - min_x) ** 2 + (max_y - min_y) ** 2 + (max_z - min_z) ** 2)

    # This output is a visual preview, so favor fast loading over machining precision.
    linear_deflection = max(diagonal / 550.0, 0.12)
    written = 0
    total_facets = 0
    seen_shapes = set()
    for index, item in enumerate(objects, start=1):
        try:
            box = item.Shape.BoundBox
            shape_key = (
                item.Shape.hashCode(2147483647),
                round(box.XMin, 5), round(box.YMin, 5), round(box.ZMin, 5),
                round(box.XMax, 5), round(box.YMax, 5), round(box.ZMax, 5),
            )
            if shape_key in seen_shapes:
                continue
            seen_shapes.add(shape_key)
            mesh = MeshPart.meshFromShape(
                Shape=item.Shape,
                LinearDeflection=linear_deflection,
                AngularDeflection=0.65,
                Relative=False,
            )
            if mesh.CountFacets == 0:
                continue
            part_path = os.path.join(output_directory, "part-%05d.stl" % written)
            mesh.write(part_path)
            total_facets += mesh.CountFacets
            written += 1
        except Exception as exc:
            print("Skipped shape %d: %s" % (index, exc), file=sys.stderr)

    if total_facets == 0:
        fail("The STEP file did not produce a viewable surface mesh.")
    print("Created %d parts and %d preview triangles at %.4f deflection" % (written, total_facets, linear_deflection))
finally:
    FreeCAD.closeDocument(document.Name)
