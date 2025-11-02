# ComfyUI-Impact-Pack: Developer Overview

## Project Type
ComfyUI-Impact-Pack is a **custom node package** for ComfyUI that provides advanced image enhancement capabilities through detectors, detailers, upscalers, and various utility nodes. It consists of both **backend (Python)** and **frontend (JavaScript)** components that work together to extend ComfyUI's functionality.

## Architecture Overview

### Backend: Python Modules (`modules/`)
The backend is organized under `modules/impact/` and contains all the node logic, image processing, and server endpoints:

#### Core Structure
- **Entry Point**: `__init__.py` - Registers all custom nodes and initializes the extension
- **Node Definitions**: Each `*_nodes.py` file defines specific node categories:
  - `impact_pack.py` - Core detector and detailer nodes
  - `detectors.py` - Detection model providers (SAM, ONNX, etc.)
  - `bridge_nodes.py` - Preview Bridge nodes for interactive editing
  - `segs_nodes.py` - SEGS (segmentation) manipulation nodes
  - `pipe.py` - Pipe-based workflow nodes
  - `util_nodes.py` - Utility and helper nodes
  - `hook_nodes.py` - Hook provider nodes for sampling customization
  - `special_samplers.py` - Custom samplers
  - `segs_upscaler.py` - Upscaling nodes
  - `logics.py` - Logic and conditional nodes
  - `wildcards.py` - Wildcard text processing
  - `hf_nodes.py` - HuggingFace integration nodes
  - `animatediff_nodes.py` - AnimateDiff support nodes

#### Core Functionality
- **`core.py`** - Core data structures (SEG, SEGS) and image processing functions
- **`utils.py`** - Shared utility functions
- **`config.py`** - Configuration management
- **`impact_server.py`** - HTTP/WebSocket API endpoints for frontend communication
- **`impact_sampling.py`** - Custom sampling logic
- **`hooks.py`** - Hook system for extending samplers

#### Node Registration
In `__init__.py`, nodes are registered via two dictionaries:
- `NODE_CLASS_MAPPINGS` - Maps node IDs to Python classes
- `NODE_DISPLAY_NAME_MAPPINGS` - Maps node IDs to display names

Example:
```python
NODE_CLASS_MAPPINGS = {
    "PreviewBridge": PreviewBridge,
    "FaceDetailer": FaceDetailer,
    # ... 200+ nodes
}
```

### Frontend: JavaScript Extensions (`js/`)
The frontend extends ComfyUI's web interface with custom behaviors, UI enhancements, and real-time communication:

#### JavaScript Files
- **`impact-pack.js`** - Main extension registration, node behaviors, and event handlers
- **`impact-image-util.js`** - Image manipulation utilities and preview handling
- **`impact-sam-editor.js`** - Interactive SAM (Segment Anything Model) editor UI
- **`impact-segs-picker.js`** - SEGS selection interface
- **`mask-rect-area.js`** - Rectangle mask drawing UI
- **`mask-rect-area-advanced.js`** - Advanced mask drawing with additional features
- **`common.js`** - Shared utilities and version checking

#### Frontend Registration
JavaScript extensions are injected into ComfyUI via:
```python
# In __init__.py
nodes.EXTENSION_WEB_DIRS["ComfyUI-Impact-Pack"] = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'js')
```

This makes all JS files available to the ComfyUI frontend under the `ComfyUI-Impact-Pack` namespace.

## Backend ↔ Frontend Communication

### 1. HTTP API Routes (Backend → Frontend)
Defined in `impact_server.py` using `PromptServer.instance.routes`:

```python
@PromptServer.instance.routes.post("/sam/prepare")
async def sam_prepare(request):
    # Load SAM model for interactive editing
    
@PromptServer.instance.routes.get("/impact/wildcards/list")
async def wildcards_list(request):
    # Return available wildcard files

@PromptServer.instance.routes.get("/impact/segs/picker/view")
async def segs_picker(request):
    # Return SEGS preview images
```

Frontend calls these endpoints using:
```javascript
await api.fetchApi('/impact/wildcards/list');
await api.fetchApi('/sam/prepare', { method: 'POST', body: JSON.stringify(data) });
```

### 2. WebSocket Events (Backend → Frontend)
Backend sends real-time updates via WebSocket:

**Backend Sends**:
```python
PromptServer.instance.send_sync("impact-node-feedback", {
    "node_id": node_id,
    "widget_name": "populated_text",
    "type": "STRING",
    "value": generated_text
})

PromptServer.instance.send_sync("impact/update_status", {
    "node": node_id,
    "progress": 0.5,
    "text": "Processing..."
})
```

**Frontend Receives**:
```javascript
api.addEventListener("impact-node-feedback", (event) => {
    // Update widget values in real-time
});

api.addEventListener("impact/update_status", ({ detail }) => {
    // Show progress badges on nodes
});
```

### 3. Custom Events
- `img-send` / `latent-send` / `value-send` - Data transfer between nodes
- `stop-iteration` - Stop execution signals
- `executed` - Node execution tracking

### 4. Prompt Processing Hooks
Backend can modify the workflow before execution:

```python
def onprompt(json_data):
    # Modify prompt data before execution
    onprompt_for_remote(json_data)
    onprompt_for_switch(json_data)
    onprompt_populate_wildcards(json_data)
    gc_preview_bridge_cache(json_data)
    return json_data

PromptServer.instance.add_on_prompt_handler(onprompt)
```

### 5. Node Behavior Customization
Frontend extends node behavior via `app.registerExtension()`:

```javascript
app.registerExtension({
    name: "Comfy.Impack",
    
    // Modify nodes before they're registered
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === 'ImpactInversedSwitch') {
            // Add custom connection handling
            nodeType.prototype.onConnectionsChange = function(...) {
                // Custom logic
            }
        }
    },
    
    // Customize nodes after creation
    nodeCreated(node, app) {
        if (node.comfyClass === "ImpactWildcardEncode") {
            // Add custom widgets, callbacks, etc.
        }
    }
});
```

## Data Flow Example: Preview Bridge

**User Interaction Flow**:
1. User loads an image in a workflow
2. `PreviewBridge` node (backend) saves image to temp directory
3. Backend returns image metadata (filename, subfolder, type)
4. Frontend displays image with mask editing capabilities
5. User draws mask in browser (handled by `impact-image-util.js`)
6. On next execution, backend reads mask from cached data
7. `PreviewBridge` outputs both image and mask to downstream nodes

**Interactive Editing Flow**:
1. Frontend sends image info to `/impact/set/pb_id_image`
2. Backend stores mapping: `node_id → (file_path, metadata)`
3. Frontend retrieves with `/impact/get/pb_id_image?id=<pb_id>`
4. User edits mask in ComfyUI's native mask editor
5. Backend reads mask from ComfyUI's clipspace
6. Mask is passed to next node in workflow

## Key Design Patterns

### 1. SEGS (Segmentation Data Structure)
```python
SEG = namedtuple("SEG", ["cropped_image", "cropped_mask", "confidence", 
                         "crop_region", "bbox", "label", "control_net_wrapper"], 
                 defaults=[None])
SEGS = Tuple[Tuple[int, int], List[SEG]]  # (original_size, seg_list)
```

This data structure flows through many nodes, allowing complex segmentation pipelines.

### 2. Pipe Pattern
Nodes like `ToDetailerPipe` bundle multiple inputs into a single "pipe" output:
```python
DETAILER_PIPE = (model, clip, vae, positive, negative, wildcard, bbox_detector, ...)
```

This reduces visual clutter in workflows.

### 3. Hook System
Allows injecting custom behavior into sampling process:
```python
class DenoiseScheduleHookProvider:
    def __init__(self, schedule_for_iteration):
        self.schedule = schedule_for_iteration
    
    def __call__(self, model, **kwargs):
        # Modify sampling parameters dynamically
```

### 4. Wildcard System
Text prompts can use wildcards that are populated during execution:
```
"a {red|blue|green} {car|truck}" 
→ "a blue car" (randomly selected)
```

Backend processes wildcards in `onprompt_populate_wildcards()`, frontend provides UI for wildcard selection.

## Development Guidelines

### Adding a New Node (Backend)
1. Create node class in appropriate `modules/impact/*_nodes.py` file
2. Define `INPUT_TYPES`, `RETURN_TYPES`, `FUNCTION`, `CATEGORY`
3. Register in `__init__.py`:
   ```python
   NODE_CLASS_MAPPINGS["MyNode"] = MyNode
   NODE_DISPLAY_NAME_MAPPINGS["MyNode"] = "My Node (Impact)"
   ```

### Extending Frontend Behavior
1. Add logic to `js/impact-pack.js` in `beforeRegisterNodeDef` or `nodeCreated`
2. For complex UI, create separate JS file (e.g., `my-feature.js`)
3. Use API routes for backend communication
4. Use WebSocket events for real-time updates

### Adding API Endpoints
1. Add route handler in `modules/impact/impact_server.py`:
   ```python
   @PromptServer.instance.routes.get("/impact/my_endpoint")
   async def my_endpoint(request):
       return web.json_response({"data": "..."})
   ```
2. Call from frontend:
   ```javascript
   const response = await api.fetchApi('/impact/my_endpoint');
   const data = await response.json();
   ```

## Dependencies

### Backend
- Core: `torch`, `numpy`, `PIL`, `cv2`
- AI/ML: `segment_anything`, `onnx`, `safetensors`
- Utils: `piexif`, `skimage`, `folder_paths` (ComfyUI)
- Server: `aiohttp` (via ComfyUI's PromptServer)

### Frontend
- ComfyUI APIs: `app`, `api`, `ComfyApp`, `ComfyDialog`
- LiteGraph (via ComfyUI)
- Native browser APIs

## File Organization Summary

```
ComfyUI-Impact-Pack/
├── __init__.py              # Entry point, node registration
├── modules/
│   └── impact/              # Backend logic
│       ├── impact_pack.py   # Core nodes
│       ├── impact_server.py # API endpoints
│       ├── core.py          # Data structures & algorithms
│       ├── *_nodes.py       # Category-specific nodes
│       └── ...
├── js/                      # Frontend extensions
│   ├── impact-pack.js       # Main extension
│   ├── impact-image-util.js # Image utilities
│   ├── impact-sam-editor.js # SAM editor UI
│   └── ...
├── requirements.txt         # Python dependencies
├── install.py              # Installation script
├── wildcards/              # Wildcard text files
├── example_workflows/      # Example workflows
└── test/                   # Test workflows
```

## Summary

ComfyUI-Impact-Pack is a sophisticated custom node package that seamlessly integrates with ComfyUI through:
- **Backend**: Python nodes providing image processing, AI detection, and workflow logic
- **Frontend**: JavaScript extensions providing interactive UI, real-time updates, and enhanced UX
- **Communication**: HTTP/WebSocket APIs, prompt hooks, and event systems for tight integration
- **Design**: Modular architecture with clear separation between node logic (Python) and UI behavior (JavaScript)

This architecture allows developers to extend functionality by adding new nodes in Python and enhancing their behavior with JavaScript, while maintaining compatibility with ComfyUI's plugin system.

