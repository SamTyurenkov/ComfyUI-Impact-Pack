import { ComfyApp, app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function load_image(str) {
	let base64String = canvas.toDataURL('image/png');
	let img = new Image();
	img.src = base64String;
}

function getFileItem(baseType, path) {
	try {
		let pathType = baseType;

		if (path.endsWith("[output]")) {
			pathType = "output";
			path = path.slice(0, -9);
		} else if (path.endsWith("[input]")) {
			pathType = "input";
			path = path.slice(0, -8);
		} else if (path.endsWith("[temp]")) {
			pathType = "temp";
			path = path.slice(0, -7);
		}

		const subfolder = path.substring(0, path.lastIndexOf('/'));
		const filename = path.substring(path.lastIndexOf('/') + 1);

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

async function loadImageFromUrl(image, node_id, v, need_to_load) {
	let item = getFileItem('temp', v);

	if(item) {
		let params = `?node_id=${node_id}&filename=${item.filename}&type=${item.type}&subfolder=${item.subfolder}`;

		let res = await api.fetchApi('/impact/set/pb_id_image'+params, { cache: "no-store" });
		if(res.status == 200) {
			let pb_id = await res.text();
			if(need_to_load) {;
				image.src = api.apiURL(`/view?filename=${item.filename}&type=${item.type}&subfolder=${item.subfolder}`);
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
		image.src = api.apiURL(`/view?filename=${item.filename}&type=${item.type}&subfolder=${item.subfolder}`);
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
			
			// Variables to track clipspace operations
			let preservedImgs = null;
			let editedFrameIndex = null;
			let clipspaceImageCount = 0;
			let savedClipspaceRef = null; // Store old clipspace reference to restore if user cancels
			
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
						const selectedIdx = ComfyApp.clipspace.selectedIndex;
						const selectedImg = ComfyApp.clipspace.imgs?.[selectedIdx];
						
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
						
						// Last resort: use clipspace selectedIdx
						if(frameIndex === null) {
							frameIndex = selectedIdx;
							console.log("[PreviewBridgeVideo] Using selectedIdx as fallback:", frameIndex);
						}
						
						localStorage.setItem(`pbv_editing_frame_${node.id}`, frameIndex.toString());
						console.log("[PreviewBridgeVideo] Stored frame index in localStorage:", frameIndex);
						
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
					const isClipspace = stackTrace.includes('pasteFromClipspace');
					console.log("[PreviewBridgeVideo] imgs setter called, length:", v ? v.length : 0, "isClipspace:", isClipspace);
					console.log("[PreviewBridgeVideo] Current node._imgs length:", node._imgs ? node._imgs.length : 0);
					
					if(v && v.length == 0) {
						console.log("[PreviewBridgeVideo] Ignoring empty array");
						return;
					}
					
					// When pasting from clipspace (mask editor), handle the edited frame
					if(isClipspace) {
						console.log("[PreviewBridgeVideo] Detected pasteFromClipspace!");
						console.log("[PreviewBridgeVideo] Image source:", v[0].src);
						
					// Preserve the current imgs array on first clipspace call
					if(!preservedImgs && node._imgs) {
						preservedImgs = [...node._imgs];
						clipspaceImageCount = 0;
						console.log("[PreviewBridgeVideo] Preserved imgs array, length:", preservedImgs.length);
						
						// Retrieve frame index from localStorage
						const storedIndex = localStorage.getItem(`pbv_editing_frame_${node.id}`);
						editedFrameIndex = storedIndex !== null ? parseInt(storedIndex, 10) : 0;
						console.log("[PreviewBridgeVideo] Retrieved frame index from localStorage:", editedFrameIndex);
						console.log("[PreviewBridgeVideo] editedFrameIndex is valid?", editedFrameIndex >= 0 && editedFrameIndex < preservedImgs.length);
						
						// Validate frame index
						if(editedFrameIndex < 0 || editedFrameIndex >= preservedImgs.length) {
							console.error("[PreviewBridgeVideo] Invalid frame index from localStorage:", editedFrameIndex, "valid range: 0-" + (preservedImgs.length - 1));
							editedFrameIndex = 0;
						}
					}
						
						// IMPORTANT: Always restore the preserved array to block external modifications
						// Even if we can't detect which frame was edited
						if(preservedImgs) {
							node._imgs = [...preservedImgs];
							console.log("[PreviewBridgeVideo] Blocked external modification, restored to length:", node._imgs.length);
						}
						
						clipspaceImageCount++;
						console.log("[PreviewBridgeVideo] Clipspace image count:", clipspaceImageCount);
						
						// Parse the clipspace filename from the URL
						let sp = new URLSearchParams(v[0].src.split("?")[1]);
						let clipspaceFile = "";
						if(sp.get('subfolder')) {
							clipspaceFile += sp.get('subfolder') + '/';
						}
						clipspaceFile += `${sp.get("filename")} [${sp.get("type")}]`;
						console.log("[PreviewBridgeVideo] Clipspace file:", clipspaceFile);
						
						// On the second clipspace call (the painted-masked image), store the reference
						if(clipspaceImageCount === 2 && editedFrameIndex !== null && editedFrameIndex >= 0 && editedFrameIndex < preservedImgs.length && v && v[0]) {
							// CRITICAL: Always save to the SELECTED frame index (the one the user picked)
							// Do NOT use paintedIndex or combinedIndex - those are just clipspace internal indices
							const targetFrameIndex = editedFrameIndex;
							console.log("[PreviewBridgeVideo] Saving edited mask to frame index:", targetFrameIndex);
							console.log("[PreviewBridgeVideo] preservedImgs.length:", preservedImgs.length);
							console.log("[PreviewBridgeVideo] Validation: targetFrameIndex < preservedImgs.length?", targetFrameIndex < preservedImgs.length);
							
							// Store a lightweight reference to the clipspace file instead of raw mask data
							// This prevents memory bloat while still allowing the backend to load masks
							try {
								// Ensure clipspaceMasksWidget.value is an object
								if(typeof clipspaceMasksWidget.value !== 'object' || clipspaceMasksWidget.value === null) {
									clipspaceMasksWidget.value = {};
								}
								
								// Store just the file reference WITH the selected frame index
								// This maps the edited mask back to the correct frame the user selected
								clipspaceMasksWidget.value[targetFrameIndex] = clipspaceFile;
								console.log("[PreviewBridgeVideo] Stored clipspace file reference for frame", targetFrameIndex, ":", clipspaceFile);
								
								// Update the preview locally for instant visual feedback
								preservedImgs[targetFrameIndex] = v[0];
								node._imgs = [...preservedImgs];
								console.log("[PreviewBridgeVideo] Updated preview with edited frame", targetFrameIndex);
							} catch(e) {
								console.error("[PreviewBridgeVideo] Failed to store clipspace reference:", e);
							}
						} else {
							console.warn("[PreviewBridgeVideo] Skipping frame update - conditions not met:", {
								clipspaceImageCount,
								editedFrameIndex,
								preservedImgsLength: preservedImgs ? preservedImgs.length : 0,
								hasImage: !!v && !!v[0]
							});
						}
						
						// After both clipspace calls, reset and trigger execution
						if(clipspaceImageCount >= 2) {
							console.log("[PreviewBridgeVideo] Clipspace sequence complete, resetting state");
							
							// Clear saved reference since save was successful
							if(savedClipspaceRef) {
								console.log("[PreviewBridgeVideo] Save successful, discarding old clipspace reference");
								savedClipspaceRef = null;
							}
							
							// node._imgs already has the updated preview (set on line 414)
							// Restore imageIndex to the edited frame so node stays on the edited frame
							if(editedFrameIndex !== null && editedFrameIndex !== undefined) {
								node.imageIndex = editedFrameIndex;
								console.log("[PreviewBridgeVideo] Restored imageIndex to edited frame:", editedFrameIndex);
								
								// Force canvas redraw to update the display
								if(app && app.canvas) {
									app.canvas.setDirty(true);
								}
							}
							
							// Clear preservedImgs so next edit starts fresh
							console.log("[PreviewBridgeVideo] Preview persisted in node._imgs with edited mask");
							preservedImgs = null;
							editedFrameIndex = null;
							clipspaceImageCount = 0;
							
							// Trigger workflow execution to update previews with masks
							// This ensures the mask overlay is rendered properly
							console.log("[PreviewBridgeVideo] Queuing workflow execution to render mask overlays");
							try {
								if(app && app.queuePrompt) {
									// Queue with the current extra data
									app.queuePrompt(0, -1);
								}
							} catch(e) {
								console.error("[PreviewBridgeVideo] Failed to queue prompt:", e);
							}
						} else if(clipspaceImageCount === 1) {
							// If we only got one clipspace call, might be cancelled or incomplete
							// Set a timeout to restore old reference if no second call comes
							setTimeout(() => {
								if(clipspaceImageCount === 1 && savedClipspaceRef) {
									console.log("[PreviewBridgeVideo] Mask editor closed without saving, restoring old clipspace reference for frame", savedClipspaceRef.frameIndex);
									clipspaceMasksWidget.value[savedClipspaceRef.frameIndex] = savedClipspaceRef.reference;
									savedClipspaceRef = null;
									clipspaceImageCount = 0;
								}
							}, 1000); // Wait 1 second for the second clipspace call
						}
						
						console.log("[PreviewBridgeVideo] Clipspace handled - imgs array protected");
						return; // Exit early
					}
					
				// Normal update from backend execution - replace entire array
				// The backend always sends ALL frames, so we replace everything
				console.log("[PreviewBridgeVideo] Normal update - replacing entire imgs array");
				console.log("[PreviewBridgeVideo] Received images:", v.length);
				
				// Log the filename of each image to verify order
				v.forEach((img, idx) => {
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
				
				node._imgs = v;
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
