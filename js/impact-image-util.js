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
		
		// Track which frame is being sent to clipspace when user opens mask editor
		node._lastOpenedFrameIndex = null;
		
		// Wrap ComfyApp.open_maskeditor to capture the frame index when it's opened
		// This is more reliable than getClipspaceData which may not be called
		if(!node._maskeditorWrapped && ComfyApp.open_maskeditor) {
			const originalOpenMaskEditor = ComfyApp.open_maskeditor;
			ComfyApp.open_maskeditor = function() {
				// Capture the index BEFORE calling original function
				// because clipspace_return_node may be cleared during the call
				if(ComfyApp.clipspace_return_node === node && ComfyApp?.clipspace?.selectedIndex !== undefined) {
					node._lastOpenedFrameIndex = ComfyApp.clipspace.selectedIndex;
					console.log("[PreviewBridgeVideo] Captured frame index BEFORE opening mask editor:", node._lastOpenedFrameIndex);
					console.log("[PreviewBridgeVideo] combinedIndex:", ComfyApp.clipspace.combinedIndex);
					console.log("[PreviewBridgeVideo] paintedIndex:", ComfyApp.clipspace.paintedIndex);
					if(ComfyApp.clipspace.imgs) {
						console.log("[PreviewBridgeVideo] All clipspace images:");
						ComfyApp.clipspace.imgs.forEach((img, idx) => {
							const filename = img.src.substring(img.src.lastIndexOf('/') + 1, img.src.indexOf('?'));
							console.log(`  [${idx}]: ${filename} ${idx === ComfyApp.clipspace.selectedIndex ? '← SELECTED' : ''} ${idx === ComfyApp.clipspace.combinedIndex ? '← COMBINED' : ''}`);
						});
					}

					// Align the combined image to the selected frame to avoid cross-frame leakage in mask editor
					try {
						const frameIdx = node._lastOpenedFrameIndex;
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
									// No stored mask for this frame; keep combined slot but mirror base image
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
		
		// Store the original array to protect it during clipspace operations
		let preservedImgs = null;
		let editedFrameIndex = null;
		let clipspaceImageCount = 0;
		
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
					
					// Use the frame index that was captured when mask editor was opened
					editedFrameIndex = node._lastOpenedFrameIndex;
					console.log("[PreviewBridgeVideo] Using captured frame index:", editedFrameIndex);
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
					
					// On the second clipspace call (the painted-masked image), update the edited frame
					// This is also where we store a reference to the clipspace file (not raw data!)
					if(clipspaceImageCount === 2 && editedFrameIndex !== null && editedFrameIndex >= 0 && editedFrameIndex < preservedImgs.length && v && v[0]) {
						console.log("[PreviewBridgeVideo] Updating frame", editedFrameIndex, "with clipspace image");
						preservedImgs[editedFrameIndex] = v[0];
						// Restore with the updated frame
						node._imgs = [...preservedImgs];
						console.log("[PreviewBridgeVideo] Updated preview with edited frame", editedFrameIndex);
						
						// Store a lightweight reference to the clipspace file instead of raw mask data
						// This prevents memory bloat while still allowing the backend to load masks
						try {
							const frameIndex = editedFrameIndex;
							
							// Ensure clipspaceMasksWidget.value is an object
							if(typeof clipspaceMasksWidget.value !== 'object' || clipspaceMasksWidget.value === null) {
								clipspaceMasksWidget.value = {};
							}
							
							// Store just the file reference WITH the frame index - much smaller than raw data!
							clipspaceMasksWidget.value[frameIndex] = clipspaceFile;
							console.log("[PreviewBridgeVideo] Stored clipspace file reference for frame", frameIndex, ":", clipspaceFile);
						} catch(e) {
							console.error("[PreviewBridgeVideo] Failed to store clipspace reference:", e);
						}
					}
					
					// After both clipspace calls, reset and trigger execution
					if(clipspaceImageCount >= 2) {
						console.log("[PreviewBridgeVideo] Clipspace sequence complete, resetting state");
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
