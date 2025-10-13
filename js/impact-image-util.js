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
			let w = node.widgets.find(obj => obj.name === 'image');
			
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
					if(isClipspace && w) {
						console.log("[PreviewBridgeVideo] Detected pasteFromClipspace!");
						console.log("[PreviewBridgeVideo] Image source:", v[0].src);
						
						// Preserve the current imgs array on first clipspace call
						if(!preservedImgs && node._imgs) {
							preservedImgs = [...node._imgs];
							clipspaceImageCount = 0;
							console.log("[PreviewBridgeVideo] Preserved imgs array, length:", preservedImgs.length);
							
							// Try multiple ways to determine which frame is being edited
							editedFrameIndex = null;
							
							// Try ComfyApp.clipspace.selectedIndex
							if(ComfyApp?.clipspace?.selectedIndex !== undefined) {
								editedFrameIndex = ComfyApp.clipspace.selectedIndex;
								console.log("[PreviewBridgeVideo] Detected edited frame from ComfyApp.clipspace.selectedIndex:", editedFrameIndex);
							}
							// Try app.canvas.ds.clipspace
							else if(app?.canvas?.ds?.clipspace?.selectedIndex !== undefined) {
								editedFrameIndex = app.canvas.ds.clipspace.selectedIndex;
								console.log("[PreviewBridgeVideo] Detected edited frame from app.canvas.ds.clipspace:", editedFrameIndex);
							}
							// As fallback, assume frame 0 (better than nothing)
							else {
								console.warn("[PreviewBridgeVideo] Could not detect edited frame index, will not update preview");
								console.log("[PreviewBridgeVideo] Available: ComfyApp.clipspace=", ComfyApp?.clipspace);
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
						
						let sp = new URLSearchParams(v[0].src.split("?")[1]);
						let str = "";
						if(sp.get('subfolder')) {
							str += sp.get('subfolder') + '/';
						}
						str += `${sp.get("filename")} [${sp.get("type")}]`;
						
						console.log("[PreviewBridgeVideo] Setting widget value to:", str);
						w.value = str;
						
						// On the second clipspace call (the painted-masked image), update the edited frame
						// This is also where we extract and store the mask data
						if(clipspaceImageCount === 2 && editedFrameIndex !== null && editedFrameIndex >= 0 && editedFrameIndex < preservedImgs.length && v && v[0]) {
							console.log("[PreviewBridgeVideo] Updating frame", editedFrameIndex, "with clipspace image");
							preservedImgs[editedFrameIndex] = v[0];
							// Restore with the updated frame
							node._imgs = [...preservedImgs];
							console.log("[PreviewBridgeVideo] Updated preview with edited frame", editedFrameIndex);
							
							// Extract mask data from the clipspace image and store it
							// The mask editor returns an image with alpha channel containing the mask
							// We need to extract this and store it in clipspace_masks widget
							try {
								// Create a canvas to extract the alpha channel
								const canvas = document.createElement('canvas');
								const img = v[0];
								
								// IMPORTANT: Capture editedFrameIndex in closure BEFORE it gets reset to null
								const frameIndex = editedFrameIndex;
								
								// Wait for image to load if needed
								const extractMask = () => {
									canvas.width = img.naturalWidth || img.width;
									canvas.height = img.naturalHeight || img.height;
									const ctx = canvas.getContext('2d');
									ctx.drawImage(img, 0, 0);
									
									// Get image data to extract alpha channel
									const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
									const alphaData = [];
									
									// Extract alpha channel (every 4th value in the data array)
									for(let i = 3; i < imageData.data.length; i += 4) {
										alphaData.push(imageData.data[i]);
									}
									
									// Store the mask data with dimensions
									const maskData = {
										width: canvas.width,
										height: canvas.height,
										data: alphaData
									};
									
									// Ensure clipspaceMasksWidget.value is an object before setting property
									if(typeof clipspaceMasksWidget.value !== 'object' || clipspaceMasksWidget.value === null) {
										clipspaceMasksWidget.value = {};
										console.log("[PreviewBridgeVideo] Reset clipspaceMasksWidget.value to empty object");
									}
									
									// Use the captured frameIndex, not editedFrameIndex which may be null by now
									clipspaceMasksWidget.value[frameIndex] = maskData;
									console.log("[PreviewBridgeVideo] Extracted and stored mask for frame", frameIndex, "size:", canvas.width, "x", canvas.height);
								};
								
								if(img.complete && img.naturalWidth) {
									extractMask();
								} else {
									img.onload = extractMask;
								}
							} catch(e) {
								console.error("[PreviewBridgeVideo] Failed to extract mask data:", e);
							}
						}
						
						// After both clipspace calls, reset
						if(clipspaceImageCount >= 2) {
							console.log("[PreviewBridgeVideo] Clipspace sequence complete, resetting state");
							preservedImgs = null;
							editedFrameIndex = null;
							clipspaceImageCount = 0;
						}
						
						console.log("[PreviewBridgeVideo] Clipspace handled - imgs array protected");
						return; // Exit early
					}
					
					// Normal update from backend execution - replace entire array
					// The backend always sends ALL frames, so we replace everything
					console.log("[PreviewBridgeVideo] Normal update - replacing entire imgs array");
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
			
			// Also log when the widget value changes
			if(w) {
				const originalValueSetter = Object.getOwnPropertyDescriptor(w, 'value')?.set;
				Object.defineProperty(w, 'value', {
					set(v) {
						console.log("[PreviewBridgeVideo] Widget 'image' value being set to:", v);
						if(originalValueSetter) {
							originalValueSetter.call(w, v);
						} else {
							w._value = v;
						}
					},
					get() {
						return w._value;
					}
				});
				console.log("[PreviewBridgeVideo] Widget value setter instrumented");
			} else {
				console.warn("[PreviewBridgeVideo] Could not find 'image' widget!");
			}
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
