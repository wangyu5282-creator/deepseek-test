const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const ARK_MODEL = 'doubao-seedream-4-5-251128';

export async function generateImage({ prompt, referenceImageUrl }) {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error('未配置 ARK_API_KEY，无法生成图片');
  }

  const body = {
    model: ARK_MODEL,
    prompt,
    sequential_image_generation: 'disabled',
    response_format: 'url',
    size: '2K',
    stream: false,
    watermark: true,
  };
  if (referenceImageUrl) {
    body.image = referenceImageUrl;
  }

  const res = await fetch(ARK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `图片生成失败: ${res.status}`);
  }

  const imageUrl = data?.data?.[0]?.url;
  if (!imageUrl) {
    throw new Error('图片生成返回结果中没有找到图片地址');
  }
  return imageUrl;
}

export function findLatestImageUrl(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j].type === 'image' && content[j].imageUrl) {
        return content[j].imageUrl;
      }
    }
  }
  return null;
}
