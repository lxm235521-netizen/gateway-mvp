// YuanAI Image binding for the gateway's gpt-image-2-4k model.
const req_mapping = `(
  $ratio := size ? size : "1:1";
  $resolutions := {
    "16:9": "3840x2160", "9:16": "2160x3840", "1:1": "4096x4096",
    "4:3": "4096x3072", "3:4": "3072x4096"
  };
  $outSize := $lookup($resolutions, $ratio) ? $lookup($resolutions, $ratio) : "4096x4096";
  $rawImages := $exists(images) ? images : [];
  $validImages := $filter($rawImages, function($image) { $exists($image) and $string($image) != "" });
  $isEdit := $count($validImages) > 0;
  $isEdit ? {
    "_route_path": "/v1/images/edits",
    "_request_format": "multipart/form-data",
    "fields": {
      "model": "gpt-image-2",
      "prompt": prompt,
      "n": n ? n : 1,
      "quality": quality ? quality : "high",
      "size": $outSize,
      "response_format": response_format ? response_format : "url"
    },
    "files": [$map($validImages, function($image, $index) {
      {
        "field": "image",
        "source": $image,
        "filename": "image-" & $string($index + 1)
      }
    })]
  } : {
    "_route_path": "/v1/images/generations",
    "aspect_ratio": $ratio,
    "image_size": "4K",
    "model": "gpt-image-2",
    "n": n ? n : 1,
    "prompt": prompt,
    "quality": quality ? quality : "high",
    "response_format": response_format ? response_format : "url",
    "size": $outSize
  }
)`;

module.exports = { req_mapping };
