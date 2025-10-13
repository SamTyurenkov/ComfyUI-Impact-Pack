import os
from PIL import ImageOps
import logging
import folder_paths
import torch
import nodes
from PIL import Image
import numpy as np
from impact import utils
import re

# NOTE: this should not be `from . import core`.
# I don't know why but... 'from .' and 'from impact' refer to different core modules.
# This separates global variables of the core module and breaks the preview bridge.
from impact import core
# <--
import random


class PreviewBridge:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
                    "images": ("IMAGE",),
                    "image": ("STRING", {"default": ""}),
                    },
                "optional": {
                    "block": ("BOOLEAN", {"default": False, "label_on": "if_empty_mask", "label_off": "never", "tooltip": "is_empty_mask: If the mask is empty, the execution is stopped.\nnever: The execution is never stopped."}),
                    "restore_mask": (["never", "always", "if_same_size"], {"tooltip": "if_same_size: If the changed input image is the same size as the previous image, restore using the last saved mask\nalways: Whenever the input image changes, always restore using the last saved mask\nnever: Do not restore the mask.\n`restore_mask` has higher priority than `block`"}),
                    },
                "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
                }

    RETURN_TYPES = ("IMAGE", "MASK", )

    FUNCTION = "doit"

    OUTPUT_NODE = True

    CATEGORY = "ImpactPack/Util"

    DESCRIPTION = "This is a feature that allows you to edit and send a Mask over a image.\nIf the block is set to 'is_empty_mask', the execution is stopped when the mask is empty."

    def __init__(self):
        super().__init__()
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"
        self.prev_hash = None

    @staticmethod
    def load_image(pb_id):
        is_fail = False
        if pb_id not in core.preview_bridge_image_id_map:
            is_fail = True

        if not is_fail:
            image_path, ui_item = core.preview_bridge_image_id_map[pb_id]
            if not os.path.isfile(image_path):
                is_fail = True

        if not is_fail:
            i = Image.open(image_path)
            i = ImageOps.exif_transpose(i)
            image = i.convert("RGB")
            image = np.array(image).astype(np.float32) / 255.0
            image = torch.from_numpy(image)[None,]

            if 'A' in i.getbands():
                mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
                mask = 1. - torch.from_numpy(mask)
            else:
                mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")
        else:
            image = utils.empty_pil_tensor()
            mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")
            ui_item = {
                "filename": 'empty.png',
                "subfolder": '',
                "type": 'temp'
            }

        return image, mask.unsqueeze(0), ui_item

    @staticmethod
    def register_clipspace_image(clipspace_path, node_id):
        """Register a clipspace image file in the preview bridge system.
        
        This handles the case where ComfyUI's mask editor creates clipspace files
        that need to be integrated with the preview bridge system.
        """
        # Remove [input] suffix if present
        clean_path = clipspace_path.replace(" [input]", "").replace("[input]", "")
        
        # Try to find the actual clipspace file
        input_dir = folder_paths.get_input_directory()
        potential_paths = [
            clean_path,
            os.path.join(input_dir, clean_path),
            os.path.join(input_dir, "clipspace", os.path.basename(clean_path)),
            os.path.abspath(clean_path),
        ]
        
        actual_file = None
        for path in potential_paths:
            if os.path.isfile(path):
                actual_file = path
                break
        
        if not actual_file:
            return False
            
        # Create ui_item for the clipspace file
        ui_item = {
            'filename': os.path.basename(actual_file),
            'subfolder': 'clipspace',
            'type': 'input'
        }
        
        # Register it using the preview bridge system
        core.set_previewbridge_image(node_id, actual_file, ui_item)
        # Also register under the original clipspace path for compatibility
        core.preview_bridge_image_id_map[clipspace_path] = (actual_file, ui_item)
        
        return True

    def doit(self, images, image, unique_id, block=False, restore_mask="never", prompt=None, extra_pnginfo=None):
        need_refresh = False
        images_changed = False

        # Check if images have changed (this determines if we start fresh)
        if unique_id not in core.preview_bridge_cache:
            need_refresh = True
            images_changed = True
        elif core.preview_bridge_cache[unique_id][0] is not images:
            need_refresh = True
            images_changed = True

        # If images changed, clear the mask cache to ensure fresh start behavior
        # This restores the original behavior where new images start with empty masks
        # unless restore_mask is set to "always" or "if_same_size"
        if images_changed and restore_mask not in ["always", "if_same_size"] and unique_id in core.preview_bridge_last_mask_cache:
            del core.preview_bridge_last_mask_cache[unique_id]

        # Handle clipspace files that aren't registered in the preview bridge system
        # This only applies when images haven't changed (same image, new mask scenario)
        if not need_refresh and image not in core.preview_bridge_image_id_map:
            # Check if this is a clipspace file that needs to be registered
            is_clipspace = image and ("clipspace" in image.lower() or "[input]" in image)
            if is_clipspace:
                if not PreviewBridge.register_clipspace_image(image, unique_id):
                    need_refresh = True
            else:
                need_refresh = True

        if not need_refresh:
            pixels, mask, path_item = PreviewBridge.load_image(image)
            image = [path_item]
        else:
            # For new images (images_changed=True), we want to start fresh regardless of restore_mask
            # For same image with refresh needed, respect the restore_mask setting
            # Exception: when restore_mask is "always", restore even with new images
            # Exception: when restore_mask is "if_same_size", allow restoration to check size compatibility
            if restore_mask != "never" and (not images_changed or restore_mask in ["always", "if_same_size"]):
                mask = core.preview_bridge_last_mask_cache.get(unique_id)
                if mask is None:
                    mask = None
                elif restore_mask == "if_same_size" and mask.shape[1:] != images.shape[1:3]:
                    # For if_same_size, clear mask if dimensions don't match
                    mask = None
                # For "always", keep the mask regardless of size
            else:
                mask = None

            if mask is None:
                mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")
                res = nodes.PreviewImage().save_images(images, filename_prefix="PreviewBridge/PB-", prompt=prompt, extra_pnginfo=extra_pnginfo)
            else:
                masked_images = utils.tensor_convert_rgba(images)
                resized_mask = utils.resize_mask(mask, (images.shape[1], images.shape[2])).unsqueeze(3)
                resized_mask = 1 - resized_mask
                utils.tensor_putalpha(masked_images, resized_mask)
                res = nodes.PreviewImage().save_images(masked_images, filename_prefix="PreviewBridge/PB-", prompt=prompt, extra_pnginfo=extra_pnginfo)

            image2 = res['ui']['images']
            pixels = images

            path = os.path.join(folder_paths.get_temp_directory(), 'PreviewBridge', image2[0]['filename'])
            core.set_previewbridge_image(unique_id, path, image2[0])
            core.preview_bridge_image_id_map[image] = (path, image2[0])
            core.preview_bridge_image_name_map[unique_id, path] = (image, image2[0])
            core.preview_bridge_cache[unique_id] = (images, image2)

            image = image2

        is_empty_mask = torch.all(mask == 0)

        if block and is_empty_mask and core.is_execution_model_version_supported():
            from comfy_execution.graph import ExecutionBlocker
            result = ExecutionBlocker(None), ExecutionBlocker(None)
        elif block and is_empty_mask:
            logging.warning("[Impact Pack] PreviewBridge: ComfyUI is outdated - blocking feature is disabled.")
            result = pixels, mask
        else:
            result = pixels, mask

        if not is_empty_mask:
            core.preview_bridge_last_mask_cache[unique_id] = mask

        return {
            "ui": {"images": image},
            "result": result,
        }


def decode_latent(latent, preview_method, vae_opt=None):
    if vae_opt is not None:
        image = nodes.VAEDecode().decode(vae_opt, latent)[0]
        return image

    from comfy.cli_args import LatentPreviewMethod
    import comfy.latent_formats as latent_formats

    if preview_method.startswith("TAE"):
        decoder_name = None

        if preview_method == "TAESD15":
            decoder_name = "taesd"
        elif preview_method == 'TAESDXL':
            decoder_name = "taesdxl"
        elif preview_method == 'TAESD3':
            decoder_name = "taesd3"
        elif preview_method == 'TAEF1':
            decoder_name = "taef1"

        if decoder_name:
            vae = nodes.VAELoader().load_vae(decoder_name)[0]
            image = nodes.VAEDecode().decode(vae, latent)[0]
            return image

    if preview_method == "Latent2RGB-SD15":
        latent_format = latent_formats.SD15()
        method = LatentPreviewMethod.Latent2RGB
    elif preview_method == "Latent2RGB-SDXL":
        latent_format = latent_formats.SDXL()
        method = LatentPreviewMethod.Latent2RGB
    elif preview_method == "Latent2RGB-SD3":
        latent_format = latent_formats.SD3()
        method = LatentPreviewMethod.Latent2RGB
    elif preview_method == "Latent2RGB-SD-X4":
        latent_format = latent_formats.SD_X4()
        method = LatentPreviewMethod.Latent2RGB
    elif preview_method == "Latent2RGB-Playground-2.5":
        latent_format = latent_formats.SDXL_Playground_2_5()
        method = LatentPreviewMethod.Latent2RGB
    elif preview_method == "Latent2RGB-SC-Prior":
        latent_format = latent_formats.SC_Prior()
        method = LatentPreviewMethod.Latent2RGB
    elif preview_method == "Latent2RGB-SC-B":
        latent_format = latent_formats.SC_B()
        method = LatentPreviewMethod.Latent2RGB
    elif preview_method == "Latent2RGB-FLUX.1":
        latent_format = latent_formats.Flux()
        method = LatentPreviewMethod.Latent2RGB
    elif preview_method == "Latent2RGB-LTXV":
        latent_format = latent_formats.LTXV()
        method = LatentPreviewMethod.Latent2RGB
    else:
        logging.warning(f"[Impact Pack] PreviewBridgeLatent: '{preview_method}' is unsupported preview method.")
        latent_format = latent_formats.SD15()
        method = LatentPreviewMethod.Latent2RGB

    previewer = core.get_previewer("cpu", latent_format=latent_format, force=True, method=method)
    samples = latent_format.process_in(latent['samples'])

    pil_image = previewer.decode_latent_to_preview(samples)
    pixels_size = pil_image.size[0]*8, pil_image.size[1]*8
    resized_image = pil_image.resize(pixels_size, resample=utils.LANCZOS)

    return utils.to_tensor(resized_image).unsqueeze(0)


class PreviewBridgeLatent:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
                    "latent": ("LATENT",),
                    "image": ("STRING", {"default": ""}),
                    "preview_method": (["Latent2RGB-FLUX.1",
                                        "Latent2RGB-SDXL", "Latent2RGB-SD15", "Latent2RGB-SD3",
                                        "Latent2RGB-SD-X4", "Latent2RGB-Playground-2.5",
                                        "Latent2RGB-SC-Prior", "Latent2RGB-SC-B",
                                        "Latent2RGB-LTXV",
                                        "TAEF1", "TAESDXL", "TAESD15", "TAESD3"],),
                    },
                "optional": {
                    "vae_opt": ("VAE", ),
                    "block": ("BOOLEAN", {"default": False, "label_on": "if_empty_mask", "label_off": "never", "tooltip": "is_empty_mask: If the mask is empty, the execution is stopped.\nnever: The execution is never stopped. Instead, it returns a white mask."}),
                    "restore_mask": (["never", "always", "if_same_size"], {"tooltip": "if_same_size: If the changed input latent is the same size as the previous latent, restore using the last saved mask\nalways: Whenever the input latent changes, always restore using the last saved mask\nnever: Do not restore the mask.\n`restore_mask` has higher priority than `block`\nIf the input latent already has a mask, do not restore mask."}),
                },
                "hidden": {"unique_id": "UNIQUE_ID", "prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
                }

    RETURN_TYPES = ("LATENT", "MASK", )

    FUNCTION = "doit"

    OUTPUT_NODE = True

    CATEGORY = "ImpactPack/Util"

    DESCRIPTION = "This is a feature that allows you to edit and send a Mask over a latent image.\nIf the block is set to 'is_empty_mask', the execution is stopped when the mask is empty."

    def __init__(self):
        super().__init__()
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"
        self.prev_hash = None
        self.prefix_append = "_temp_" + ''.join(random.choice("abcdefghijklmnopqrstupvxyz") for x in range(5))

    @staticmethod
    def load_image(pb_id):
        is_fail = False
        if pb_id not in core.preview_bridge_image_id_map:
            is_fail = True

        if not is_fail:
            image_path, ui_item = core.preview_bridge_image_id_map[pb_id]
            if not os.path.isfile(image_path):
                is_fail = True

        if not is_fail:
            i = Image.open(image_path)
            i = ImageOps.exif_transpose(i)
            image = i.convert("RGB")
            image = np.array(image).astype(np.float32) / 255.0
            image = torch.from_numpy(image)[None,]

            if 'A' in i.getbands():
                mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
                mask = 1. - torch.from_numpy(mask)
            else:
                mask = None
        else:
            image = utils.empty_pil_tensor()
            mask = None
            ui_item = {
                "filename": 'empty.png',
                "subfolder": '',
                "type": 'temp'
            }

        return image, mask, ui_item

    def doit(self, latent, image, preview_method, vae_opt=None, block=False, unique_id=None, restore_mask='never', prompt=None, extra_pnginfo=None):
        latent_channels = latent['samples'].shape[1]

        if 'SD3' in preview_method or 'SC-Prior' in preview_method or 'FLUX.1' in preview_method or 'TAEF1' == preview_method:
            preview_method_channels = 16
        elif 'LTXV' in preview_method:
            preview_method_channels = 128
        else:
            preview_method_channels = 4

        if vae_opt is None and latent_channels != preview_method_channels:
            logging.warning("[PreviewBridgeLatent] The version of latent is not compatible with preview_method.\nSD3, SD1/SD2, SDXL, SC-Prior, SC-B and FLUX.1 are not compatible with each other.")
            raise Exception("The version of latent is not compatible with preview_method.<BR>SD3, SD1/SD2, SDXL, SC-Prior, SC-B and FLUX.1 are not compatible with each other.")

        need_refresh = False
        latent_changed = False

        # Check if latent has changed
        if unique_id not in core.preview_bridge_cache:
            need_refresh = True
            latent_changed = True
        elif (core.preview_bridge_cache[unique_id][0] is not latent
              or (vae_opt is None and core.preview_bridge_cache[unique_id][2] is not None)
              or (vae_opt is None and core.preview_bridge_cache[unique_id][1] != preview_method)
              or (vae_opt is not None and core.preview_bridge_cache[unique_id][2] is not vae_opt)):
            need_refresh = True
            latent_changed = True

        # If latent changed, clear the mask cache to ensure fresh start behavior
        # unless restore_mask is set to "always" or "if_same_size"
        if latent_changed and restore_mask not in ["always", "if_same_size"] and unique_id in core.preview_bridge_last_mask_cache:
            del core.preview_bridge_last_mask_cache[unique_id]

        # Handle clipspace files that aren't registered in the preview bridge system
        # This only applies when latent hasn't changed (same latent, new mask scenario)
        if not need_refresh and image not in core.preview_bridge_image_id_map:
            is_clipspace = image and ("clipspace" in image.lower() or "[input]" in image)
            if is_clipspace:
                if not PreviewBridge.register_clipspace_image(image, unique_id):
                    need_refresh = True
            else:
                need_refresh = True

        if not need_refresh:
            pixels, mask, path_item = PreviewBridge.load_image(image)

            if mask is None:
                mask = torch.ones(latent['samples'].shape[2:], dtype=torch.float32, device="cpu").unsqueeze(0)
                if 'noise_mask' in latent:
                    res_latent = latent.copy()
                    del res_latent['noise_mask']
                else:
                    res_latent = latent

                is_empty_mask = True
            else:
                res_latent = latent.copy()
                res_latent['noise_mask'] = mask

                is_empty_mask = torch.all(mask == 1)

            res_image = [path_item]
        else:
            decoded_image = decode_latent(latent, preview_method, vae_opt)

            if 'noise_mask' in latent:
                mask = latent['noise_mask'].squeeze(0)  # 4D mask -> 3D mask

                decoded_pil = utils.to_pil(decoded_image)

                inverted_mask = 1 - mask  # invert
                resized_mask = utils.resize_mask(inverted_mask, (decoded_image.shape[1], decoded_image.shape[2]))
                result_pil = utils.apply_mask_alpha_to_pil(decoded_pil, resized_mask)

                full_output_folder, filename, counter, _, _ = folder_paths.get_save_image_path("PreviewBridge/PBL-"+self.prefix_append, folder_paths.get_temp_directory(), result_pil.size[0], result_pil.size[1])
                file = f"{filename}_{counter}.png"
                result_pil.save(os.path.join(full_output_folder, file), compress_level=4)
                res_image = [{
                                'filename': file,
                                'subfolder': 'PreviewBridge',
                                'type': 'temp',
                            }]

                is_empty_mask = False
            else:
                # For new latents (latent_changed=True), start fresh regardless of restore_mask
                # For same latent with refresh needed, respect the restore_mask setting
                # Exception: when restore_mask is "always", restore even with new latents
                # Exception: when restore_mask is "if_same_size", allow restoration to check size compatibility
                if restore_mask != "never" and (not latent_changed or restore_mask in ["always", "if_same_size"]):
                    mask = core.preview_bridge_last_mask_cache.get(unique_id)
                    if mask is None:
                        mask = None
                    elif restore_mask == "if_same_size" and mask.shape[1:] != decoded_image.shape[1:3]:
                        # For if_same_size, clear mask if dimensions don't match
                        mask = None
                    # For "always", keep the mask regardless of size
                else:
                    mask = None

                if mask is None:
                    mask = torch.ones(latent['samples'].shape[2:], dtype=torch.float32, device="cpu").unsqueeze(0)
                    res = nodes.PreviewImage().save_images(decoded_image, filename_prefix="PreviewBridge/PBL-", prompt=prompt, extra_pnginfo=extra_pnginfo)
                else:
                    masked_images = utils.tensor_convert_rgba(decoded_image)
                    resized_mask = utils.resize_mask(mask, (decoded_image.shape[1], decoded_image.shape[2])).unsqueeze(3)
                    resized_mask = 1 - resized_mask
                    utils.tensor_putalpha(masked_images, resized_mask)
                    res = nodes.PreviewImage().save_images(masked_images, filename_prefix="PreviewBridge/PBL-", prompt=prompt, extra_pnginfo=extra_pnginfo)

                res_image = res['ui']['images']

            is_empty_mask = torch.all(mask == 1)

            path = os.path.join(folder_paths.get_temp_directory(), 'PreviewBridge', res_image[0]['filename'])
            core.set_previewbridge_image(unique_id, path, res_image[0])
            core.preview_bridge_image_id_map[image] = (path, res_image[0])
            core.preview_bridge_image_name_map[unique_id, path] = (image, res_image[0])
            core.preview_bridge_cache[unique_id] = (latent, preview_method, vae_opt, res_image)

            res_latent = latent

        if block and is_empty_mask and core.is_execution_model_version_supported():
            from comfy_execution.graph import ExecutionBlocker
            result = ExecutionBlocker(None), ExecutionBlocker(None)
        elif block and is_empty_mask:
            logging.warning("[Impact Pack] PreviewBridgeLatent: ComfyUI is outdated - blocking feature is disabled.")
            result = res_latent, mask
        else:
            result = res_latent, mask

        if not is_empty_mask:
            core.preview_bridge_last_mask_cache[unique_id] = mask

        return {
            "ui": {"images": res_image},
            "result": result,
        }


class PreviewBridgeVideo:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
                    "images": ("IMAGE",),
                    "image": ("STRING", {"default": ""}),
                    },
                "optional": {
                    "masks": ("MASK",),
                    "block": ("BOOLEAN", {"default": False, "label_on": "if_empty_mask", "label_off": "never", "tooltip": "is_empty_mask: If all masks are empty, the execution is stopped.\nnever: The execution is never stopped."}),
                    "restore_mask": (["if_same_size", "always", "never"], {"tooltip": "if_same_size: If the input image is the same size as the previous image, restore the last saved masks (default)\nalways: Always restore the last saved masks, even when input images change\nnever: Do not restore masks - start fresh each time"}),
                    },
                "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO", "clipspace_masks": "CLIPSPACE_MASKS"},
                }

    RETURN_TYPES = ("IMAGE", "MASK", )

    FUNCTION = "doit"

    OUTPUT_NODE = True

    CATEGORY = "ImpactPack/Util"

    DESCRIPTION = "This is a feature that allows you to edit masks for individual frames in a batch of images.\nClick on any frame preview and open in MaskEditor to edit its mask.\nAll frames and their masks are preserved.\nIf the block is set to 'is_empty_mask', the execution is stopped when all masks are empty."

    def __init__(self):
        super().__init__()
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"
        self.prev_hash = None

    @staticmethod
    def convert_clipspace_masks_to_tensors(clipspace_masks):
        """Convert clipspace_masks from frontend format to torch tensors.
        
        Frontend format: {index: {width: int, height: int, data: [alpha values]}}
        Backend format: {index: torch.Tensor}
        """
        if not clipspace_masks or not isinstance(clipspace_masks, dict):
            return {}
        
        converted = {}
        for idx_key, mask_data in clipspace_masks.items():
            try:
                # Skip null/None keys that may come from JavaScript
                if idx_key is None or idx_key == 'null' or idx_key == 'undefined':
                    logging.warning(f"[PreviewBridgeVideo] Skipping invalid clipspace mask key: {idx_key}")
                    continue
                
                # Convert string keys to int
                idx = int(idx_key) if isinstance(idx_key, str) else idx_key
                
                # If already a tensor, keep it
                if torch.is_tensor(mask_data):
                    converted[idx] = mask_data
                    continue
                
                # Convert from frontend format
                if isinstance(mask_data, dict) and 'width' in mask_data and 'height' in mask_data and 'data' in mask_data:
                    width = mask_data['width']
                    height = mask_data['height']
                    data = mask_data['data']
                    
                    # Convert to numpy array, reshape, then to tensor
                    # Alpha values are 0-255, normalize to 0-1
                    # Invert: 255 (opaque) -> 0 (no mask), 0 (transparent) -> 1 (full mask)
                    mask_array = np.array(data, dtype=np.float32)
                    mask_array = (255.0 - mask_array) / 255.0
                    mask_array = mask_array.reshape(height, width)
                    
                    # Convert to tensor and add batch dimension
                    mask_tensor = torch.from_numpy(mask_array).unsqueeze(0)
                    converted[idx] = mask_tensor
                    logging.info(f"[PreviewBridgeVideo] Converted clipspace mask for frame {idx}: {width}x{height}")
                else:
                    logging.warning(f"[PreviewBridgeVideo] Invalid clipspace mask format for index {idx}: {type(mask_data)}")
            except Exception as e:
                logging.error(f"[PreviewBridgeVideo] Failed to convert clipspace mask for index {idx_key}: {e}")
        
        return converted

    @staticmethod
    def load_image(pb_id):
        is_fail = False
        if pb_id not in core.preview_bridge_image_id_map:
            is_fail = True

        if not is_fail:
            image_path, ui_item = core.preview_bridge_image_id_map[pb_id]
            if not os.path.isfile(image_path):
                is_fail = True

        if not is_fail:
            i = Image.open(image_path)
            i = ImageOps.exif_transpose(i)
            image = i.convert("RGB")
            image = np.array(image).astype(np.float32) / 255.0
            image = torch.from_numpy(image)[None,]

            if 'A' in i.getbands():
                mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
                mask = 1. - torch.from_numpy(mask)
            else:
                mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")
        else:
            image = utils.empty_pil_tensor()
            mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")
            ui_item = {
                "filename": 'empty.png',
                "subfolder": '',
                "type": 'temp'
            }

        return image, mask.unsqueeze(0), ui_item

    def doit(self, images, image, unique_id, masks=None, block=False, restore_mask="if_same_size", prompt=None, extra_pnginfo=None, clipspace_masks=None):
        batch_size = images.shape[0]
        
        logging.info(f"[PreviewBridgeVideo] === Execution Start ===")
        logging.info(f"[PreviewBridgeVideo] unique_id={unique_id}, batch_size={batch_size}, restore_mask={restore_mask}")
        logging.info(f"[PreviewBridgeVideo] image param='{image[:50] if image else 'None'}...'")
        logging.info(f"[PreviewBridgeVideo] clipspace_masks type: {type(clipspace_masks)}, value: {clipspace_masks if not isinstance(clipspace_masks, (list, dict)) else f'container with {len(clipspace_masks)} items'}")
        
        # Use a special cache key structure to avoid conflicts with regular PreviewBridge
        video_cache_key = f"{unique_id}_video"
        
        if video_cache_key not in core.preview_bridge_cache:
            core.preview_bridge_cache[video_cache_key] = {}
            logging.info(f"[PreviewBridgeVideo] Created new preview cache")

        node_cache = core.preview_bridge_cache[video_cache_key]
        
        # Initialize clipspace_masks array if not provided or if it's not a proper container
        if clipspace_masks is None or not isinstance(clipspace_masks, (list, dict)):
            # Try to restore from node_cache as fallback
            if 'clipspace_masks' in node_cache:
                clipspace_masks = node_cache['clipspace_masks']
                logging.info(f"[PreviewBridgeVideo] Restored clipspace_masks from node_cache")
            else:
                clipspace_masks = {}
                logging.info(f"[PreviewBridgeVideo] Initialized empty clipspace_masks")
        elif isinstance(clipspace_masks, list):
            # Convert list to dict for easier index access
            clipspace_masks = {i: mask for i, mask in enumerate(clipspace_masks) if mask is not None}
            logging.info(f"[PreviewBridgeVideo] Converted clipspace_masks list to dict")
        
        # Convert clipspace_masks from frontend format (if needed) to torch tensors
        clipspace_masks = PreviewBridgeVideo.convert_clipspace_masks_to_tensors(clipspace_masks)
        
        logging.info(f"[PreviewBridgeVideo] Clipspace masks count: {len(clipspace_masks)}")
        logging.info(f"[PreviewBridgeVideo] Clipspace mask frames: {list(clipspace_masks.keys())}")
        
        # Check if images have changed
        images_changed = False
        if 'images_ref' not in node_cache or node_cache['images_ref'] is not images:
            images_changed = True
            node_cache['images_ref'] = images
            logging.info(f"[PreviewBridgeVideo] Images CHANGED - clearing clipspace_masks if restore_mask='never'")
            # Clear clipspace_masks if images changed and restore_mask is "never"
            if restore_mask == "never":
                clipspace_masks.clear()
                logging.info(f"[PreviewBridgeVideo] Cleared clipspace_masks (restore_mask='never')")
        else:
            logging.info(f"[PreviewBridgeVideo] Images UNCHANGED")
        
        # Initialize masks if not provided
        if masks is None:
            masks = torch.zeros((batch_size, images.shape[1], images.shape[2]), dtype=torch.float32, device="cpu")
        elif masks.shape[0] != batch_size:
            # Resize mask batch to match image batch size
            if masks.shape[0] == 1:
                masks = masks.repeat(batch_size, 1, 1)
            else:
                new_masks = torch.zeros((batch_size, images.shape[1], images.shape[2]), dtype=torch.float32, device="cpu")
                copy_size = min(batch_size, masks.shape[0])
                new_masks[:copy_size] = masks[:copy_size]
                masks = new_masks
        
        # Restore masks from clipspace_masks if needed
        # Restore masks if: restore_mask is "always", OR restore_mask is not "never" and images haven't changed
        should_restore = (restore_mask == "always") or (restore_mask != "never" and not images_changed)
        
        logging.info(f"[PreviewBridgeVideo] Should restore masks: {should_restore}")
        
        if should_restore:
            restored_count = 0
            for idx in range(batch_size):
                if idx in clipspace_masks:
                    cached_mask = clipspace_masks[idx]
                    logging.info(f"[PreviewBridgeVideo] Found clipspace mask for frame {idx}, shape: {cached_mask.shape}")
                    # Check size compatibility for "if_same_size"
                    if restore_mask == "if_same_size" and images_changed:
                        if cached_mask.shape[1:] == masks.shape[1:3]:
                            masks[idx] = cached_mask.squeeze(0) if len(cached_mask.shape) > 2 else cached_mask
                            restored_count += 1
                            logging.info(f"[PreviewBridgeVideo] Restored mask for frame {idx} (if_same_size with image change)")
                        else:
                            logging.info(f"[PreviewBridgeVideo] Skipped frame {idx} - size mismatch: {cached_mask.shape[1:]} vs {masks.shape[1:3]}")
                    else:
                        # For "always" or when images haven't changed, restore regardless
                        if cached_mask.shape[1:] == masks.shape[1:3]:
                            masks[idx] = cached_mask.squeeze(0) if len(cached_mask.shape) > 2 else cached_mask
                            restored_count += 1
                            logging.info(f"[PreviewBridgeVideo] Restored mask for frame {idx}")
                        else:
                            logging.info(f"[PreviewBridgeVideo] Skipped frame {idx} - size mismatch: {cached_mask.shape[1:]} vs {masks.shape[1:3]}")
            logging.info(f"[PreviewBridgeVideo] Total masks restored: {restored_count}/{batch_size}")

        # Check if this is a fresh run or coming back from mask editor
        is_fresh_run = not image or image.startswith(f"${unique_id}")
        logging.info(f"[PreviewBridgeVideo] is_fresh_run: {is_fresh_run}")
        
        # Handle mask editor return (clipspace)
        if not is_fresh_run and image:
            logging.info(f"[PreviewBridgeVideo] Processing clipspace return...")
            # Try to load the edited image with mask from clipspace
            is_clipspace = "clipspace" in image.lower() or "[input]" in image
            logging.info(f"[PreviewBridgeVideo] is_clipspace: {is_clipspace}")
            
            if is_clipspace:
                PreviewBridge.register_clipspace_image(image, unique_id)
            
            if image in core.preview_bridge_image_id_map:
                logging.info(f"[PreviewBridgeVideo] Found image in preview_bridge_image_id_map")
                # Load the edited frame - capture both RGB and alpha
                edited_rgb, edited_mask, path_item = PreviewBridgeVideo.load_image(image)
                logging.info(f"[PreviewBridgeVideo] Loaded edited image, RGB shape: {edited_rgb.shape}, mask shape: {edited_mask.shape}, non-zero: {torch.sum(edited_mask > 0).item()}")
                
                # Try multiple methods to find the frame index
                frame_idx = None
                
                # Method 1: Check if we have a stored "last_edited_frame_idx" from when user clicked on a frame
                # This is set by the frontend when a specific frame is opened in mask editor
                if 'last_edited_frame_idx' in node_cache:
                    frame_idx = node_cache['last_edited_frame_idx']
                    logging.info(f"[PreviewBridgeVideo] Found frame index from last_edited_frame_idx: {frame_idx}")
                
                # Method 2: Check if this image ID is in our frame map
                if frame_idx is None and 'frame_map' in node_cache and image in node_cache['frame_map']:
                    frame_idx = node_cache['frame_map'][image]
                    logging.info(f"[PreviewBridgeVideo] Found frame index from frame_map: {frame_idx}")
                
                # Method 3: Parse from the original filename in preview bridge map
                if frame_idx is None:
                    image_path, _ = core.preview_bridge_image_id_map.get(image, (None, None))
                    logging.info(f"[PreviewBridgeVideo] Trying to parse from path: {image_path}")
                    if image_path:
                        # Extract frame index from filename like "PBV-123-0042-..."
                        match = re.search(r'PBV-[^-]+-(\d+)', image_path)
                        if match:
                            frame_idx = int(match.group(1))
                            logging.info(f"[PreviewBridgeVideo] Parsed frame index from filename: {frame_idx}")
                
                # Update both RGB and mask for the identified frame
                if frame_idx is not None and 0 <= frame_idx < batch_size:
                    logging.info(f"[PreviewBridgeVideo] Batch size before update: {images.shape[0]}")
                    
                    # Ensure edited_rgb has correct shape and matches images device/dtype
                    edited_rgb = edited_rgb.to(device=images.device, dtype=images.dtype)
                    
                    # Combine the RGB from mask editor with the original image dimensions
                    if edited_rgb.shape[1:3] == images.shape[1:3]:
                        # Direct replacement if dimensions match - use clone to ensure no shape issues
                        images = torch.cat([
                            images[:frame_idx],
                            edited_rgb,
                            images[frame_idx+1:]
                        ], dim=0)
                        logging.info(f"[PreviewBridgeVideo] ✓ Updated RGB for frame {frame_idx}")
                    else:
                        # Resize if needed (shouldn't normally happen, but safety check)
                        logging.warning(f"[PreviewBridgeVideo] Size mismatch: edited {edited_rgb.shape} vs batch {images.shape}, resizing...")
                        from PIL import Image
                        edited_pil = Image.fromarray((edited_rgb.squeeze(0).cpu().numpy() * 255).astype(np.uint8))
                        edited_pil_resized = edited_pil.resize((images.shape[2], images.shape[1]), Image.LANCZOS)
                        edited_rgb_resized = torch.from_numpy(np.array(edited_pil_resized).astype(np.float32) / 255.0).unsqueeze(0).to(device=images.device, dtype=images.dtype)
                        images = torch.cat([
                            images[:frame_idx],
                            edited_rgb_resized,
                            images[frame_idx+1:]
                        ], dim=0)
                        logging.info(f"[PreviewBridgeVideo] ✓ Updated RGB for frame {frame_idx} (resized)")
                    
                    logging.info(f"[PreviewBridgeVideo] Batch size after update: {images.shape[0]}")
                    
                    # Verify batch size hasn't changed
                    if images.shape[0] != batch_size:
                        logging.error(f"[PreviewBridgeVideo] ERROR: Batch size changed from {batch_size} to {images.shape[0]}!")
                        batch_size = images.shape[0]  # Update to prevent index errors
                    
                    masks[frame_idx] = edited_mask.squeeze(0)
                    logging.info(f"[PreviewBridgeVideo] ✓ Updated mask for frame {frame_idx}")
                else:
                    logging.warning(f"[PreviewBridgeVideo] ✗ Could not identify frame index! frame_idx={frame_idx}")
            else:
                logging.warning(f"[PreviewBridgeVideo] Image not found in preview_bridge_image_id_map")

        # Generate previews for ALL frames
        image_list = []
        frame_to_path_map = {}  # Track which frame index corresponds to which file
        
        # Clear old frame_map to avoid stale registrations
        if 'frame_map' in node_cache:
            logging.info(f"[PreviewBridgeVideo] Clearing old frame_map with {len(node_cache['frame_map'])} entries")
            node_cache['frame_map'] = {}
        
        logging.info(f"[PreviewBridgeVideo] About to generate {batch_size} previews, images.shape={images.shape}")
        
        for idx in range(batch_size):
            current_frame = images[idx:idx+1]
            current_mask = masks[idx:idx+1]
            
            # Check if mask is empty
            if torch.all(current_mask == 0):
                # No mask - just show the image
                res = nodes.PreviewImage().save_images(
                    current_frame, 
                    filename_prefix=f"PreviewBridge/PBV-{unique_id}-{idx:04d}-", 
                    prompt=prompt, 
                    extra_pnginfo=extra_pnginfo
                )
            else:
                # Has mask - show image with mask overlay
                masked_images = utils.tensor_convert_rgba(current_frame)
                resized_mask = utils.resize_mask(current_mask, (current_frame.shape[1], current_frame.shape[2])).unsqueeze(3)
                resized_mask = 1 - resized_mask
                utils.tensor_putalpha(masked_images, resized_mask)
                res = nodes.PreviewImage().save_images(
                    masked_images, 
                    filename_prefix=f"PreviewBridge/PBV-{unique_id}-{idx:04d}-", 
                    prompt=prompt, 
                    extra_pnginfo=extra_pnginfo
                )
            
            frame_image_list = res['ui']['images']
            image_list.extend(frame_image_list)
            
            # Store mapping for this frame
            if frame_image_list:
                img_path = os.path.join(folder_paths.get_temp_directory(), 'PreviewBridge', frame_image_list[0]['filename'])
                frame_to_path_map[img_path] = idx
                # Register each frame for preview bridge
                pb_id = core.set_previewbridge_image(unique_id, img_path, frame_image_list[0])
                # Store frame index in multiple formats for lookup when clipspace returns
                if 'frame_map' not in node_cache:
                    node_cache['frame_map'] = {}
                # Store with pb_id as key
                node_cache['frame_map'][pb_id] = idx
                # Also store with the image path as key
                node_cache['frame_map'][img_path] = idx
                # And store index-to-pb_id reverse mapping
                node_cache['frame_map'][f"idx_{idx}"] = pb_id
                logging.info(f"[PreviewBridgeVideo] Registered frame {idx} with pb_id: {pb_id}")
        
        # Save masks to clipspace_masks for restore_mask functionality
        saved_count = 0
        for idx in range(batch_size):
            if not torch.all(masks[idx] == 0):
                clipspace_masks[idx] = masks[idx:idx+1]
                saved_count += 1
                logging.info(f"[PreviewBridgeVideo] Saved mask for frame {idx} to clipspace_masks")
            elif idx in clipspace_masks:
                # Remove empty masks from clipspace_masks
                del clipspace_masks[idx]
        logging.info(f"[PreviewBridgeVideo] Total masks saved to clipspace_masks: {saved_count}/{batch_size}")
        
        # Store clipspace_masks in node_cache for persistence across executions
        node_cache['clipspace_masks'] = clipspace_masks
        logging.info(f"[PreviewBridgeVideo] Stored clipspace_masks in node_cache")
        
        logging.info(f"[PreviewBridgeVideo] Final image_list length: {len(image_list)} (expected: {batch_size})")
        logging.info(f"[PreviewBridgeVideo] Final images batch shape: {images.shape}")
        logging.info(f"[PreviewBridgeVideo] Final masks batch shape: {masks.shape}")
        logging.info(f"[PreviewBridgeVideo] === Execution End ===")
        
        # Check if all masks are empty for block functionality
        all_masks_empty = torch.all(masks == 0)
        
        if block and all_masks_empty and core.is_execution_model_version_supported():
            from comfy_execution.graph import ExecutionBlocker
            result = ExecutionBlocker(None), ExecutionBlocker(None)
        elif block and all_masks_empty:
            logging.warning("[Impact Pack] PreviewBridgeVideo: ComfyUI is outdated - blocking feature is disabled.")
            result = (images, masks)
        else:
            result = (images, masks)
            
        return {
            "ui": {"images": image_list},
            "result": result,
        }