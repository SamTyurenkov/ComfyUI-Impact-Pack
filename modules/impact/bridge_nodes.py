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
                    },
                "optional": {
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
    def convert_clipspace_masks_to_tensors(clipspace_masks, unique_id):
        """Convert clipspace_masks from frontend format to torch tensors with RGB and mask data.
        
        Frontend format: {frame_index: "clipspace/filename.png [input]"} - file reference with frame index as key
        Backend format: {frame_index: {'rgb': torch.Tensor, 'mask': torch.Tensor}}
        """
        if not clipspace_masks or not isinstance(clipspace_masks, dict):
            return {}
        
        converted = {}
        for idx_key, clipspace_file in clipspace_masks.items():
            try:
                # Convert string keys to int
                idx = int(idx_key) if isinstance(idx_key, str) else idx_key
                
                # If already a dict with rgb and mask tensors, keep it (from node_cache)
                if isinstance(clipspace_file, dict) and 'rgb' in clipspace_file and 'mask' in clipspace_file:
                    converted[idx] = clipspace_file
                    continue
                
                # Handle file reference (string path) - load BOTH RGB and mask
                if isinstance(clipspace_file, str):
                    # Register the clipspace file and load both RGB and mask from it
                    if PreviewBridge.register_clipspace_image(clipspace_file, unique_id):
                        if clipspace_file in core.preview_bridge_image_id_map:
                            loaded_rgb, loaded_mask, _ = PreviewBridgeVideo.load_image(clipspace_file)
                            converted[idx] = {
                                'rgb': loaded_rgb,
                                'mask': loaded_mask
                            }
                            logging.info(f"[PreviewBridgeVideo] Loaded clipspace RGB+mask for frame {idx} from: {clipspace_file}")
                        else:
                            logging.warning(f"[PreviewBridgeVideo] Failed to load clipspace file for frame {idx}: {clipspace_file}")
                else:
                    logging.warning(f"[PreviewBridgeVideo] Unexpected format for frame {idx}: {type(clipspace_file)}")
            except Exception as e:
                logging.error(f"[PreviewBridgeVideo] Failed to convert clipspace data for frame {idx_key}: {e}")
        
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

    def doit(self, images, unique_id, block=False, restore_mask="if_same_size", prompt=None, extra_pnginfo=None, clipspace_masks=None):
        batch_size = images.shape[0]
        
        logging.info(f"[PreviewBridgeVideo] === Execution Start ===")
        logging.info(f"[PreviewBridgeVideo] unique_id={unique_id}, batch_size={batch_size}, restore_mask={restore_mask}")
        logging.info(f"[PreviewBridgeVideo] clipspace_masks: {clipspace_masks if not isinstance(clipspace_masks, dict) or len(clipspace_masks) < 3 else f'dict with {len(clipspace_masks)} frames'}")
        
        # Use a special cache key structure to avoid conflicts with regular PreviewBridge
        video_cache_key = f"{unique_id}_video"
        
        if video_cache_key not in core.preview_bridge_cache:
            core.preview_bridge_cache[video_cache_key] = {}
            logging.info(f"[PreviewBridgeVideo] Created new preview cache")

        node_cache = core.preview_bridge_cache[video_cache_key]
        
        # Initialize clipspace_masks - either from frontend or from node_cache
        from_cache = False
        if not clipspace_masks or not isinstance(clipspace_masks, dict):
            # Try to restore from node_cache as fallback
            if 'clipspace_masks' in node_cache:
                clipspace_masks = node_cache['clipspace_masks']
                from_cache = True
                logging.info(f"[PreviewBridgeVideo] Restored clipspace_masks from node_cache: {len(clipspace_masks)} frames")
            else:
                clipspace_masks = {}
                logging.info(f"[PreviewBridgeVideo] Initialized empty clipspace_masks")
        else:
            # Log what we received from frontend
            logging.info(f"[PreviewBridgeVideo] Received clipspace_masks from frontend: type={type(clipspace_masks)}, keys={list(clipspace_masks.keys()) if isinstance(clipspace_masks, dict) else 'not a dict'}")
            if isinstance(clipspace_masks, dict):
                for key, value in clipspace_masks.items():
                    logging.info(f"[PreviewBridgeVideo]   clipspace_masks[{key}] = {value if isinstance(value, str) else type(value)}")
        
        # Convert clipspace_masks from frontend format (if needed) to torch tensors
        # Skip conversion if we loaded from cache (already in tensor format)
        if not from_cache:
            clipspace_masks = PreviewBridgeVideo.convert_clipspace_masks_to_tensors(clipspace_masks, unique_id)
        
        logging.info(f"[PreviewBridgeVideo] Loaded clipspace data for frames: {list(clipspace_masks.keys())}")
        
        # Check if images have changed
        images_changed = False
        if 'images_ref' not in node_cache or node_cache['images_ref'] is not images:
            images_changed = True
            node_cache['images_ref'] = images
            logging.info(f"[PreviewBridgeVideo] Images CHANGED")
            # Clear clipspace_masks if images changed and restore_mask is "never"
            if restore_mask == "never":
                clipspace_masks.clear()
                logging.info(f"[PreviewBridgeVideo] Cleared clipspace_masks (restore_mask='never')")
        else:
            logging.info(f"[PreviewBridgeVideo] Images UNCHANGED")
        
        # Initialize masks - always start with zeros
        masks = torch.zeros((batch_size, images.shape[1], images.shape[2]), dtype=torch.float32, device="cpu")
        
        # Restore both RGB and masks from clipspace_masks if needed
        should_restore = (restore_mask == "always") or (restore_mask != "never" and not images_changed)
        
        logging.info(f"[PreviewBridgeVideo] Should restore: {should_restore}")
        
        if should_restore:
            restored_count = 0
            for idx, cached_data in clipspace_masks.items():
                if idx >= batch_size:
                    logging.warning(f"[PreviewBridgeVideo] Frame {idx} out of range (batch_size={batch_size}), skipping")
                    continue
                
                cached_mask = cached_data.get('mask')
                cached_rgb = cached_data.get('rgb')
                
                if cached_mask is None:
                    logging.warning(f"[PreviewBridgeVideo] Frame {idx} has no mask data, skipping")
                    continue
                
                # Check size compatibility
                mask_matches = cached_mask.shape[1:] == masks.shape[1:3]
                rgb_matches = cached_rgb is not None and cached_rgb.shape[1:3] == images.shape[1:3]
                
                # For "if_same_size" with image change, only restore if sizes match
                if restore_mask == "if_same_size" and images_changed and not mask_matches:
                    logging.info(f"[PreviewBridgeVideo] Skipped frame {idx} - size mismatch")
                    continue
                
                # Restore mask
                if mask_matches:
                    masks[idx] = cached_mask.squeeze(0) if len(cached_mask.shape) > 2 else cached_mask
                    restored_count += 1
                
                # Restore RGB
                if rgb_matches:
                    images[idx] = cached_rgb.squeeze(0) if len(cached_rgb.shape) > 3 else cached_rgb
                    logging.info(f"[PreviewBridgeVideo] Restored RGB+mask for frame {idx}")
                else:
                    logging.info(f"[PreviewBridgeVideo] Restored mask only for frame {idx}")
            
            logging.info(f"[PreviewBridgeVideo] Restored {restored_count} frames")

        # No need to check for fresh run anymore - we rely entirely on clipspace_masks
        # which already contains the frame indices as keys

        # Generate previews for ALL frames
        image_list = []
        
        logging.info(f"[PreviewBridgeVideo] Generating {batch_size} previews")
        
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
            logging.info(f"[PreviewBridgeVideo] Added frame {idx}: {frame_image_list[0]['filename']}, image_list now has {len(image_list)} items")
            
        # Save both RGB and masks to clipspace_masks for frames that have masks
        saved_count = 0
        for idx in range(batch_size):
            if not torch.all(masks[idx] == 0):
                # Store both RGB and mask for edited frames
                clipspace_masks[idx] = {
                    'rgb': images[idx:idx+1].clone(),
                    'mask': masks[idx:idx+1].clone()
                }
                saved_count += 1
            elif idx in clipspace_masks:
                # Remove frames that no longer have masks
                del clipspace_masks[idx]
        
        # Store clipspace_masks in node_cache for persistence
        node_cache['clipspace_masks'] = clipspace_masks
        
        logging.info(f"[PreviewBridgeVideo] Saved {saved_count} frames with masks")
        logging.info(f"[PreviewBridgeVideo] Final image_list order:")
        for i, img in enumerate(image_list):
            logging.info(f"[PreviewBridgeVideo]   image_list[{i}] = {img['filename']}")
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