import { ComfyApp, app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function load_image(str) {
	let base64String = canvas.toDataURL('image/png');
	let img = new Image();
	img.src = base64String;
}

function getFileItem(baseType, path) {
	try {
		if(!path || typeof path !== "string") {
			return null;
		}

		path = path.replace(/\\/g, '/').trim();
		let pathType = baseType;
		const annotation = path.match(/\s*\[(output|input|temp)\]\s*$/i);
		if(annotation) {
			pathType = annotation[1].toLowerCase();
			path = path.slice(0, annotation.index).trim();
		}

		const slashIndex = path.lastIndexOf('/');
		const subfolder = slashIndex >= 0 ? path.substring(0, slashIndex) : "";
		const filename = slashIndex >= 0 ? path.substring(slashIndex + 1) : path;
		if(!filename) {
			return null;
		}

		return {
			filename: filename,
			subfolder: subfolder,
			type: pathType
		};
	}
	catch(exception) {
		return null;
	}
}

function getViewUrl(item) {
	const params = new URLSearchParams();
	params.set("filename", item.filename);
	params.set("type", item.type || "temp");
	if(item.subfolder) {
		params.set("subfolder", item.subfolder);
	}

	let url = api.apiURL(`/view?${params.toString()}`);
	if(app.getPreviewFormatParam) {
		url += app.getPreviewFormatParam();
	}
	if(app.getRandParam) {
		url += app.getRandParam();
	}
	return url;
}

async function loadImageFromUrl(image, node_id, v, need_to_load) {
	let item = getFileItem('temp', v);

	if(item) {
		let params = `?node_id=${node_id}&filename=${item.filename}&type=${item.type}&subfolder=${item.subfolder}`;

		let res = await api.fetchApi('/impact/set/pb_id_image'+params, { cache: "no-store" });
		if(res.status == 200) {
			let pb_id = await res.text();
			if(need_to_load) {
				image.src = getViewUrl(item);
			}
			return pb_id;
		}
		else {
			return `$${node_id}-0`;
		}
	}
	else {
		return `$${node_id}-0`;
	}
}

async function loadImageFromId(image, v) {
	let res = await api.fetchApi('/impact/get/pb_id_image?id='+v, { cache: "no-store" });
	if(res.status == 200) {
		let item = await res.json();
		image.src = getViewUrl(item);
		return true;
	}

	return false;
}

app.registerExtension({
	name: "Comfy.Impact.img",

	nodeCreated(node, app) {
		if(node.comfyClass == "PreviewBridge" || node.comfyClass == "PreviewBridgeLatent") {
			let w = node.widgets.find(obj => obj.name === 'image');
			node._imgs = [new Image()];
			node.imageIndex = 0;

			Object.defineProperty(w, 'value', {
				async set(v) {
					if(w._lock)
						return;

					const stackTrace = new Error().stack;
					if(stackTrace.includes('presetText.js'))
						return;

					var image = new Image();
					if(v && v.constructor == String && v.startsWith('$')) {
						// from node feedback
						let need_to_load = node._imgs[0].src == '';
						if(await loadImageFromId(image, v, need_to_load)) {
							w._value = v;
							if(node._imgs[0].src == '') {
								node._imgs = [image];
							}
						}
						else {
							w._value = `$${node.id}-0`;
						}
					}
					else {
						// from clipspace
						w._lock = true;
						w._value = await loadImageFromUrl(image, node.id, v, false);
						w._lock = false;
					}
				},
				get() {
					if(w._value == undefined) {
						w._value = `$${node.id}-0`;
					}
					return w._value;
				}
			});

			Object.defineProperty(node, 'imgs', {
				set(v) {
					const stackTrace = new Error().stack;
					if(v && v.length == 0)
						return;
					else if(stackTrace.includes('pasteFromClipspace')) {
						let sp = new URLSearchParams(v[0].src.split("?")[1]);
						let str = "";
						if(sp.get('subfolder')) {
							str += sp.get('subfolder') + '/';
						}
						str += `${sp.get("filename")} [${sp.get("type")}]`;

						w.value = str;
					}

					node._imgs = v;
				},
				get() {
					return node._imgs;
				}
			});
		}

		if(node.comfyClass == "PreviewBridgeVideo") {
			console.log("[PreviewBridgeVideo] Initializing frontend for node", node.id);

			// New frontend can open mask editor from context menu while only `overIndex` is set.
			// Mirror that into `imageIndex` so mask editor targets the hovered frame.
			const originalOnMouseDown = node.onMouseDown;
			node.onMouseDown = function() {
				const result = originalOnMouseDown ? originalOnMouseDown.apply(this, arguments) : undefined;
				const pointerDownIndex = Number.isInteger(this.pointerDown?.index) ? this.pointerDown.index : null;
				const clickIndex = pointerDownIndex !== null
					? pointerDownIndex
					: (Number.isInteger(this.overIndex) ? this.overIndex : null);
				if(Number.isInteger(clickIndex)) {
					this.imageIndex = clickIndex;
					localStorage.setItem(`pbv_editing_frame_${this.id}`, String(clickIndex));
				}
				return result;
			};

			// Core frontend context-menu action ("Open in MaskEditor | Image Canvas")
			// can call mask editor directly without going through ComfyApp.open_maskeditor.
			// Ensure imageIndex is pinned to hovered frame before the callback executes.
			const originalGetExtraMenuOptions = node.getExtraMenuOptions;
			node.getExtraMenuOptions = function(canvas, options) {
				const ret = originalGetExtraMenuOptions ? originalGetExtraMenuOptions.apply(this, arguments) : undefined;
				if(Array.isArray(options)) {
					for(let i = 0; i < options.length; i++) {
						const opt = options[i];
						if(opt && typeof opt.content === "string" && opt.content.includes("Open in MaskEditor")) {
							const originalCallback = opt.callback;
							const pointerDownIndex = Number.isInteger(this.pointerDown?.index) ? this.pointerDown.index : null;
							const capturedIndex = Number.isInteger(this.overIndex)
								? this.overIndex
								: (pointerDownIndex !== null
								? pointerDownIndex
								: (Number.isInteger(this.imageIndex) ? this.imageIndex : 0));
							opt.callback = (...args) => {
								const preferredIndex = capturedIndex;
								if(Number.isInteger(preferredIndex)) {
									this.imageIndex = preferredIndex;
									localStorage.setItem(`pbv_editing_frame_${this.id}`, String(preferredIndex));
								}

								// Mask editor loader resolves node.images[0] first; provide selected metadata briefly.
								let restoreImages = null;
								if(Array.isArray(this.images) && this.images.length > 1) {
									const selectedMeta = this.images[preferredIndex] || this.images[0];
									restoreImages = this.images;
									this.images = selectedMeta ? [selectedMeta] : this.images;
								}
								if(restoreImages) {
									setTimeout(() => {
										try {
											this.images = restoreImages;
										} catch {
											// ignore
										}
									}, 120);
								}
								return originalCallback ? originalCallback.apply(this, args) : undefined;
							};
						}
					}
				}
				return ret;
			};

			// Initialize clipspace_masks widget if it doesn't exist
			let clipspaceMasksWidget = node.widgets.find(obj => obj.name === 'clipspace_masks');
			if(!clipspaceMasksWidget) {
				// Create hidden widget for clipspace_masks
				// serialize: true so it gets sent to backend during execution
				// But we'll clear it after backend processes it to avoid bloating localStorage
				clipspaceMasksWidget = {
					name: 'clipspace_masks',
					type: 'clipspace_masks',
					value: {},
					options: { serialize: true }
				};
				node.widgets.push(clipspaceMasksWidget);
				console.log("[PreviewBridgeVideo] Created clipspace_masks widget");
			}
			
			// Initialize clipspace_masks value as object/dict - ensure it's always an object
			if(!clipspaceMasksWidget.value || typeof clipspaceMasksWidget.value !== 'object' || Array.isArray(clipspaceMasksWidget.value)) {
				clipspaceMasksWidget.value = {};
				console.log("[PreviewBridgeVideo] Initialized clipspace_masks widget value to empty object");
			}

			const toRefString = (item) => {
				if(!item || !item.filename) return null;
				const sub = item.subfolder ? `${item.subfolder}/` : "";
				const typ = item.type || "input";
				return `${sub}${item.filename} [${typ}]`;
			};

			const isPreviewBridgeTempRef = (ref) => {
				return typeof ref === "string" && ref.includes("PreviewBridge/PBV-") && ref.includes("[temp]");
			};

			const refFromWidgetValue = () => {
				const imageWidget = node.widgets?.find(obj => obj.name === 'image');
				const widgetValue = imageWidget?.value;
				if(typeof widgetValue === "string" && widgetValue.trim() !== "" && !widgetValue.startsWith("$")) {
					const parsed = getFileItem('input', widgetValue);
					if(parsed && parsed.filename) {
						return toRefString(parsed);
					}
				}
				return null;
			};

			const refFromNodeImages = () => {
				if(Array.isArray(node.images) && node.images[0] && node.images[0].filename) {
					return toRefString(node.images[0]);
				}
				return null;
			};

			const refFromClipspace = () => {
				const clipspace = ComfyApp?.clipspace;
				if(!clipspace || !Array.isArray(clipspace.images) || clipspace.images.length === 0) {
					return null;
				}
				const selectedIndex = Number.isInteger(clipspace.selectedIndex) ? clipspace.selectedIndex : 0;
				const selected = clipspace.images[selectedIndex] || clipspace.images[0];
				return selected ? toRefString(selected) : null;
			};

			const resolveCurrentMaskRef = () => {
				const widgetRef = refFromWidgetValue();
				const nodeRef = refFromNodeImages();
				const clipspaceRef = refFromClipspace();
				if(clipspaceRef && !isPreviewBridgeTempRef(clipspaceRef)) return clipspaceRef;
				if(widgetRef && !isPreviewBridgeTempRef(widgetRef)) return widgetRef;
				if(nodeRef && !isPreviewBridgeTempRef(nodeRef)) return nodeRef;
				if(clipspaceRef) return clipspaceRef;
				if(widgetRef) return widgetRef;
				if(nodeRef) return nodeRef;
				return null;
			};

			const setFrameMaskReference = (frameIndex) => {
				if(!Number.isInteger(frameIndex) || frameIndex < 0) {
					return false;
				}

				const ref = resolveCurrentMaskRef();
				if(!ref) {
					return false;
				}

				if(!clipspaceMasksWidget.value || typeof clipspaceMasksWidget.value !== 'object' || Array.isArray(clipspaceMasksWidget.value)) {
					clipspaceMasksWidget.value = {};
				}

				clipspaceMasksWidget.value = {
					...clipspaceMasksWidget.value,
					[frameIndex]: ref
				};
				console.log("[PreviewBridgeVideo] Stored mask reference from saver for frame", frameIndex, ":", ref);
				return true;
			};
			
			// Variables to track clipspace operations
			let preservedImgs = null;
			let editedFrameIndex = null;
			let clipspaceImageCount = 0;
			let savedClipspaceRef = null; // Store old clipspace reference to restore if user cancels
			let pendingSaverReset = false; // Frontend saver does node.imgs=[one] then node.imgs=undefined
			let pendingSaverFrameIndex = null; // target frame for deferred reference capture
			let pendingSaverDataUrl = null; // direct saver payload fallback for backend conversion

			const resolveTargetFrameIndex = () => {
				const storedIndex = localStorage.getItem(`pbv_editing_frame_${node.id}`);
				const parsedStored = storedIndex !== null ? parseInt(storedIndex, 10) : null;
				if(Number.isInteger(parsedStored) && parsedStored >= 0) {
					return parsedStored;
				}
				if(Number.isInteger(node.imageIndex) && node.imageIndex >= 0) {
					return node.imageIndex;
				}
				if(Number.isInteger(node.overIndex) && node.overIndex >= 0) {
					return node.overIndex;
				}
				return 0;
			};
			
			// Wrap ComfyApp.open_maskeditor to capture the frame index when it's opened
			if(!node._maskeditorWrapped && ComfyApp.open_maskeditor) {
				const originalOpenMaskEditor = ComfyApp.open_maskeditor;
				ComfyApp.open_maskeditor = function() {
					// Reset clipspace tracking state when mask editor opens
					if(ComfyApp.clipspace_return_node === node) {
						preservedImgs = null;
						editedFrameIndex = null;
						clipspaceImageCount = 0;
						savedClipspaceRef = null;
						console.log("[PreviewBridgeVideo] Reset clipspace state on mask editor open");
					}
					
					// Store which frame was clicked in localStorage
					if(ComfyApp.clipspace_return_node === node && ComfyApp?.clipspace?.selectedIndex !== undefined) {
						const pointerDownIndex = Number.isInteger(node.pointerDown?.index) ? node.pointerDown.index : null;
						const preferredIndex = Number.isInteger(node.overIndex)
							? node.overIndex
							: (pointerDownIndex !== null
							? pointerDownIndex
							: (Number.isInteger(node.imageIndex) ? node.imageIndex : null));

						// Keep clipspace selection aligned with the node's current frame.
						// Newer frontend flows can default to frame 0 unless this is synced.
						if(preferredIndex !== null && ComfyApp.clipspace?.imgs?.length) {
							const maxIdx = Math.max(0, ComfyApp.clipspace.imgs.length - 1);
							const syncedIdx = Math.min(Math.max(preferredIndex, 0), maxIdx);
							ComfyApp.clipspace.selectedIndex = syncedIdx;
						}

						const selectedIdx = ComfyApp.clipspace.selectedIndex;
						const selectedImg = ComfyApp.clipspace.imgs?.[selectedIdx];
						const nodeImageIndex = preferredIndex;
						
						// Find which position in node._imgs this image is at
						let frameIndex = null;
						if(selectedImg && node._imgs) {
							console.log("[PreviewBridgeVideo] Searching for frame, node._imgs.length:", node._imgs.length);
							console.log("[PreviewBridgeVideo] Selected image src:", selectedImg.src);
							
							// Try exact object match first
							for(let i = 0; i < node._imgs.length; i++) {
								if(node._imgs[i] === selectedImg) {
									frameIndex = i;
									console.log("[PreviewBridgeVideo] Found frame by object match at index:", i);
									break;
								}
							}
							
							// Fallback: try src match (for cases where ComfyUI creates new Image objects)
							if(frameIndex === null && selectedImg.src) {
								for(let i = 0; i < node._imgs.length; i++) {
									const imgSrc = node._imgs[i]?.src;
									if(imgSrc === selectedImg.src) {
										frameIndex = i;
										console.log("[PreviewBridgeVideo] Found frame by src match at index:", i);
										break;
									}
								}
							}
						}
						
						// Last resort: use node.imageIndex first, then clipspace selectedIdx
						if(frameIndex === null) {
							if(nodeImageIndex !== null) {
								frameIndex = nodeImageIndex;
								console.log("[PreviewBridgeVideo] Using node.imageIndex as fallback:", frameIndex);
							} else {
								frameIndex = selectedIdx;
								console.log("[PreviewBridgeVideo] Using selectedIdx as fallback:", frameIndex);
							}
						}
						
						localStorage.setItem(`pbv_editing_frame_${node.id}`, frameIndex.toString());
						console.log("[PreviewBridgeVideo] Stored frame index in localStorage:", frameIndex);
						node.imageIndex = frameIndex;
						
						// Save the old clipspace reference for this frame (in case user cancels)
						// and clear it from the widget so mask editor starts fresh
						if(clipspaceMasksWidget.value && clipspaceMasksWidget.value[frameIndex]) {
							savedClipspaceRef = {
								frameIndex: frameIndex,
								reference: clipspaceMasksWidget.value[frameIndex]
							};
							delete clipspaceMasksWidget.value[frameIndex];
							console.log("[PreviewBridgeVideo] Saved and cleared old clipspace reference for frame", frameIndex, ":", savedClipspaceRef.reference);
						} else {
							console.log("[PreviewBridgeVideo] No existing clipspace reference to clear for frame", frameIndex);
						}

						// Align the combined image to the selected frame to avoid cross-frame leakage in mask editor
						try {
							const frameIdx = frameIndex;
							const widget = node.widgets.find(obj => obj.name === 'clipspace_masks');
							const mapping = widget && widget.value && typeof widget.value === 'object' ? widget.value : null;
							const refStr = mapping && (mapping[frameIdx] || mapping[String(frameIdx)]) ? (mapping[frameIdx] || mapping[String(frameIdx)]) : null;
							const imgs = ComfyApp?.clipspace?.imgs;
							const selectedIdx = ComfyApp?.clipspace?.selectedIndex;
							const combinedIdx = ComfyApp?.clipspace?.combinedIndex;

							if(imgs && typeof selectedIdx === 'number') {
								if(refStr) {
									// refStr format: "subfolder/filename [type]" or "filename [type]"
									const typeMatch = /\[(.*?)\]\s*$/.exec(refStr);
									const type = typeMatch ? typeMatch[1] : 'input';
									const pathPart = refStr.replace(/\s*\[.*\]\s*$/, '');
									let subfolder = '';
									let filename = pathPart;
									if(pathPart.includes('/')) {
										const parts = pathPart.split('/');
										subfolder = parts.slice(0, -1).join('/');
										filename = parts[parts.length - 1];
									}

									const baseUrl = new URL(imgs[selectedIdx].src);
									baseUrl.searchParams.set('filename', filename);
									if(subfolder) baseUrl.searchParams.set('subfolder', subfolder); else baseUrl.searchParams.delete('subfolder');
									baseUrl.searchParams.set('type', type);
									baseUrl.searchParams.delete('channel');

									const newImg = new Image();
									newImg.crossOrigin = 'anonymous';
									newImg.src = baseUrl.toString();

									if(typeof combinedIdx === 'number' && imgs[combinedIdx] !== undefined) {
										imgs[combinedIdx] = newImg;
										if(ComfyApp.clipspace.images) {
											ComfyApp.clipspace.images[combinedIdx] = { filename, subfolder, type };
										}
										console.log('[PreviewBridgeVideo] Set combined image for frame', frameIdx, '->', filename);
									} else {
										ComfyApp.clipspace.combinedIndex = undefined;
										console.log('[PreviewBridgeVideo] No combined slot; cleared combinedIndex');
									}
									} else {
										// No stored mask for this frame
										// Check if base image has no alpha (RGB preview) - this means mask was cleared
										// If it has alpha (RGBA), it's an unedited frame with alpha channel
										// For now, just mirror the base image - the backend handles whether to show alpha
										if(typeof combinedIdx === 'number' && imgs[combinedIdx] !== undefined) {
											const mirror = new Image();
											mirror.crossOrigin = 'anonymous';
											mirror.src = imgs[selectedIdx].src;
											imgs[combinedIdx] = mirror;
											if(ComfyApp.clipspace.images) {
												// best-effort mirror of metadata if present
												const selUrl = new URL(imgs[selectedIdx].src);
												ComfyApp.clipspace.images[combinedIdx] = {
													filename: selUrl.searchParams.get('filename') || '',
													subfolder: selUrl.searchParams.get('subfolder') || '',
													type: selUrl.searchParams.get('type') || 'input'
												};
											}
											console.log('[PreviewBridgeVideo] Mirrored base image into combined slot for frame', frameIdx);
										}
									}
							}
						} catch(e) {
							console.warn('[PreviewBridgeVideo] Failed to align combined image for selected frame:', e);
						}
					}
					return originalOpenMaskEditor.apply(this, arguments);
				};
				node._maskeditorWrapped = true;
			}
				
			// Hook into execution lifecycle to clear masks after they're sent to backend
			const originalOnExecuted = node.onExecuted;
			node.onExecuted = function(message) {
				// Clear the widget value after execution to prevent localStorage bloat
				// The backend has cached the masks in node_cache, so they'll be restored from there
				if(clipspaceMasksWidget.value && Object.keys(clipspaceMasksWidget.value).length > 0) {
					console.log("[PreviewBridgeVideo] Clearing clipspace_masks widget after execution (backend has cached them)");
					clipspaceMasksWidget.value = {};
				}
				
				if(originalOnExecuted) {
					return originalOnExecuted.apply(this, arguments);
				}
			};
			
			// Handle clipspace return from mask editor
			Object.defineProperty(node, 'imgs', {
				set(v) {
					const stackTrace = new Error().stack;
					const fromStack = stackTrace.includes('pasteFromClipspace');
					const clipspaceReturningToNode = ComfyApp.clipspace_return_node === node;
					const fromMaskEditorSaver = stackTrace.includes('useMaskEditorSaver');
					const looksLikeCollapsedClipspaceReturn =
						!!(clipspaceReturningToNode && node._imgs && node._imgs.length > 1 && v && v.length === 1);
					const hasStoredEditingFrame = localStorage.getItem(`pbv_editing_frame_${node.id}`) !== null;
					const isMaskEditorSingleFrameUpdate =
						!!((fromMaskEditorSaver || hasStoredEditingFrame) && node._imgs && node._imgs.length > 1 && v && v.length === 1);
					const isClipspace = fromStack || clipspaceReturningToNode || looksLikeCollapsedClipspaceReturn;
					const isSingleDataUrlSavePreview =
						!!(Array.isArray(v) && v.length === 1 &&
							node._imgs && node._imgs.length > 1 &&
							typeof v[0]?.src === "string" &&
							v[0].src.startsWith("data:image/"));
					console.log("[PreviewBridgeVideo] imgs setter called, length:", v ? v.length : 0, "isClipspace:", isClipspace);
					console.log("[PreviewBridgeVideo] Current node._imgs length:", node._imgs ? node._imgs.length : 0);

					// New frontend saver path may temporarily clear imgs after setting a single-frame preview.
					// Ignore this reset to keep the full frame batch visible until backend refresh.
					if((v === undefined || v === null) && pendingSaverReset) {
						pendingSaverReset = false;
						if(Number.isInteger(pendingSaverFrameIndex) && typeof pendingSaverDataUrl === "string" && pendingSaverDataUrl.startsWith("data:image/")) {
							if(!clipspaceMasksWidget.value || typeof clipspaceMasksWidget.value !== 'object' || Array.isArray(clipspaceMasksWidget.value)) {
								clipspaceMasksWidget.value = {};
							}
							clipspaceMasksWidget.value = {
								...clipspaceMasksWidget.value,
								[pendingSaverFrameIndex]: { data_url: pendingSaverDataUrl }
							};
							console.log("[PreviewBridgeVideo] Stored data-url mask payload for frame", pendingSaverFrameIndex);
						} else if(Number.isInteger(pendingSaverFrameIndex)) {
							if(!setFrameMaskReference(pendingSaverFrameIndex)) {
								setTimeout(() => setFrameMaskReference(pendingSaverFrameIndex), 300);
							}
						}
						pendingSaverFrameIndex = null;
						pendingSaverDataUrl = null;
						console.log("[PreviewBridgeVideo] Ignoring temporary imgs reset from mask editor saver");
						return;
					}

					// Defensive: ignore null/undefined writes that would wipe a valid batch.
					// Some frontend paths can transiently set `node.imgs = undefined`.
					if(v === undefined || v === null) {
						if(node._imgs && node._imgs.length > 0) {
							console.log("[PreviewBridgeVideo] Ignoring null/undefined imgs update to preserve existing batch");
							return;
						}
						node._imgs = [];
						return;
					}
					
					if(v && v.length == 0) {
						console.log("[PreviewBridgeVideo] Ignoring empty array");
						return;
					}
					
					// Handle the new mask editor saver behavior that writes a single-frame preview directly.
					// Update only the edited frame instead of replacing the whole batch.
					if(isMaskEditorSingleFrameUpdate && v && v[0]) {
						const targetFrameIndex = resolveTargetFrameIndex();
						if(Number.isInteger(targetFrameIndex) && targetFrameIndex >= 0 && targetFrameIndex < node._imgs.length) {
							const preserved = [...node._imgs];
							preserved[targetFrameIndex] = v[0];
							node._imgs = preserved;
							node.imageIndex = targetFrameIndex;
							localStorage.setItem(`pbv_editing_frame_${node.id}`, String(targetFrameIndex));
							pendingSaverReset = true;
							pendingSaverFrameIndex = targetFrameIndex;
							pendingSaverDataUrl = typeof v[0]?.src === "string" ? v[0].src : null;
							if(typeof pendingSaverDataUrl === "string" && pendingSaverDataUrl.startsWith("data:image/")) {
								if(!clipspaceMasksWidget.value || typeof clipspaceMasksWidget.value !== 'object' || Array.isArray(clipspaceMasksWidget.value)) {
									clipspaceMasksWidget.value = {};
								}
								clipspaceMasksWidget.value = {
									...clipspaceMasksWidget.value,
									[targetFrameIndex]: { data_url: pendingSaverDataUrl }
								};
								console.log("[PreviewBridgeVideo] Stored immediate data-url mask payload for frame", targetFrameIndex);
							}
							console.log("[PreviewBridgeVideo] Applied single-frame saver update to frame:", targetFrameIndex);
							if(app && app.canvas) {
								app.canvas.setDirty(true);
							}
							return;
						}
					}
					
					// New frontend save preview path can arrive as a single data-url image and
					// would collapse the whole batch if treated as normal backend update.
					if(isSingleDataUrlSavePreview && v && v[0]) {
						const targetFrameIndex = resolveTargetFrameIndex();
						if(Number.isInteger(targetFrameIndex) && targetFrameIndex >= 0 && targetFrameIndex < node._imgs.length) {
							const preserved = [...node._imgs];
							preserved[targetFrameIndex] = v[0];
							node._imgs = preserved;
							node.imageIndex = targetFrameIndex;
							localStorage.setItem(`pbv_editing_frame_${node.id}`, String(targetFrameIndex));
							pendingSaverReset = true;
							pendingSaverFrameIndex = targetFrameIndex;
							pendingSaverDataUrl = typeof v[0]?.src === "string" ? v[0].src : null;
							if(typeof pendingSaverDataUrl === "string" && pendingSaverDataUrl.startsWith("data:image/")) {
								if(!clipspaceMasksWidget.value || typeof clipspaceMasksWidget.value !== 'object' || Array.isArray(clipspaceMasksWidget.value)) {
									clipspaceMasksWidget.value = {};
								}
								clipspaceMasksWidget.value = {
									...clipspaceMasksWidget.value,
									[targetFrameIndex]: { data_url: pendingSaverDataUrl }
								};
								console.log("[PreviewBridgeVideo] Stored immediate data-url mask payload for frame", targetFrameIndex);
							}
							console.log("[PreviewBridgeVideo] Applied single data-url save preview to frame:", targetFrameIndex);
							if(app && app.canvas) {
								app.canvas.setDirty(true);
							}
							return;
						}
					}

					// When pasting from clipspace (mask editor), handle the edited frame
					if(isClipspace) {
						// Clipspace internals can emit transient single-image writes.
						// Keep the full batch untouched here and rely on saver path below.
						if(node._imgs && node._imgs.length > 0) {
							console.log("[PreviewBridgeVideo] Ignoring clipspace transient imgs update to preserve full batch");
							return;
						}
					}
					
				// Normal update from backend execution - replace entire array
				// The backend always sends ALL frames, so we replace everything
				console.log("[PreviewBridgeVideo] Normal update - replacing entire imgs array");
				console.log("[PreviewBridgeVideo] Received images:", v ? v.length : 0);
				
				// Log the filename of each image to verify order
				(v || []).forEach((img, idx) => {
					if(img && img.src) {
						let match = img.src.match(/PBV-\d+-(\d{4})/);
						let frameIdx = match ? match[1] : 'unknown';
						console.log(`[PreviewBridgeVideo] imgs[${idx}] -> frame ${frameIdx}: ${img.src.substring(img.src.lastIndexOf('/') + 1, img.src.lastIndexOf('?'))}`);
					}
				});
				
				// Log clipspace_masks widget contents
				if(clipspaceMasksWidget && clipspaceMasksWidget.value) {
					console.log("[PreviewBridgeVideo] clipspace_masks widget contents:", JSON.stringify(clipspaceMasksWidget.value));
					console.log("[PreviewBridgeVideo] clipspace_masks keys:", Object.keys(clipspaceMasksWidget.value));
				}
				
				if(Array.isArray(v) && v.length > 0) {
					node._imgs = v;
					if(Number.isInteger(node.imageIndex) && node.imageIndex >= node._imgs.length) {
						node.imageIndex = Math.max(0, node._imgs.length - 1);
					}
				} else {
					console.log("[PreviewBridgeVideo] Ignoring normal update with empty image payload");
				}
				preservedImgs = null; // Clear preservation since we have new data
				editedFrameIndex = null;
				clipspaceImageCount = 0;
				
				// Note: We DON'T clear clipspace_masks here because the backend will
				// restore them if needed based on restore_mask setting
				// The backend manages clipspace_masks state
				
				console.log("[PreviewBridgeVideo] node._imgs updated to length:", node._imgs.length);
				},
				get() {
					if(!node._imgs) {
						node._imgs = [];
					}
					if(node._imgs.length > 0 && Number.isInteger(node.imageIndex) && node.imageIndex >= node._imgs.length) {
						node.imageIndex = Math.max(0, node._imgs.length - 1);
					}
					return node._imgs;
				}
			});
		}

		if(node.comfyClass == "ImageReceiver") {
			let path_widget = node.widgets.find(obj => obj.name === 'image');
			let w = node.widgets.find(obj => obj.name === 'image_data');
			let stw_widget = node.widgets.find(obj => obj.name === 'save_to_workflow');
			w._value = "";

			Object.defineProperty(w, 'value', {
				set(v) {
					if(v != '[IMAGE DATA]')
						w._value = v;
				},
				get() {
					const stackTrace = new Error().stack;
					if(!stackTrace.includes('draw') && !stackTrace.includes('graphToPrompt') && stackTrace.includes('app.js')) {
						return "[IMAGE DATA]";
					}
					else {
						if(stw_widget.value)
							return w._value;
						else
							return "";
					}
				}
			});

			let set_img_act = (v) => {
				node._img = v;
				var canvas = document.createElement('canvas');
				canvas.width = v[0].width;
				canvas.height = v[0].height;

				var context = canvas.getContext('2d');
				context.drawImage(v[0], 0, 0, v[0].width, v[0].height);

				var base64Image = canvas.toDataURL('image/png');
				w.value = base64Image;
			};

			Object.defineProperty(node, 'imgs', {
				set(v) {
					if (v && !v[0].complete) {
						let orig_onload = v[0].onload;
						v[0].onload = function(v2) {
							if(orig_onload)
								orig_onload();
							set_img_act(v);
						};
					}
					else {
						set_img_act(v);
					}
				},
				get() {
					if(this._img == undefined && w.value != '') {
						this._img = [new Image()];
						if(stw_widget.value && w.value != '[IMAGE DATA]')
							this._img[0].src = w.value;
					}
					else if(this._img == undefined && path_widget.value) {
						let image = new Image();
						image.src = path_widget.value;

						try {
							let item = getFileItem('temp', path_widget.value);
							let params = `?filename=${item.filename}&type=${item.type}&subfolder=${item.subfolder}`;

							let res = api.fetchApi('/view/validate'+params, { cache: "no-store" }).then(response => response);
							if(res.status == 200) {
								image.src = api.apiURL('/view'+params);
							}

							this._img = [new Image()]; // placeholder
							image.onload = function(v) {
								set_img_act([image]);
							};
						}
						catch {

						}
					}
					return this._img;
				}
			});
		}
	}
})
