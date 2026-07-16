+++
author = "haen"
title = "MiMo TTS VoiceClone"
url = "/mimo-tts-voiceclone/"
date = "2026-06-16"
description = "MiMo TTS VoiceClone 使用指南：从参考音频克隆声音、生成任意文本语音的完整方案，含前置准备、核心脚本、使用方法、模型选择和成本参考。"
tags = [
  "记录",
]
+++

# MiMo TTS VoiceClone

> 让任意AI助手具备语音克隆能力的完整指南

---

## 🔧 前置准备

### 1. 获取API Key
- 访问小米MiMo开放平台申请API Key
- 当前使用的API地址: `https://token-plan-cn.xiaomimimo.com/v1`

### 2. 准备参考音频
- 格式: MP3 或 WAV
- 建议: 16kHz采样率，64kbps码率（约80KB）
- 内容: 清晰的说话音频，10-30秒为宜
- 优化: 文件越小，API响应越快

```bash
# 转换参考音频为优化格式
ffmpeg -y -i original.wav -ar 16000 -ac 1 -b:a 64k optimized.mp3
```

### 3. 环境依赖
- Python 3.x
- ffmpeg（用于音频格式转换）

---

## 📝 核心脚本

保存为 `mimo_tts.py`:

```python
#!/usr/bin/env python3
"""
MiMo TTS Provider
Supports: mimo-v2.5-tts (preset), mimo-v2.5-tts-voicedesign (description), mimo-v2.5-tts-voiceclone (sample)
"""
import argparse, base64, json, os, subprocess, sys, tempfile, urllib.request, urllib.error

# 参考音频路径（修改为你的路径）
REF_VOICE_PATH = os.path.expanduser("~/reference_voice.mp3")

def get_api_url():
    url = os.environ.get("MIMO_TTS_URL")
    if url:
        return url
    base = os.environ.get("XIAOMI_BASE_URL", "https://token-plan-cn.xiaomimimo.com/v1")
    return base + "/chat/completions"

def get_api_key():
    # 优先从环境变量读取
    key = os.environ.get("XIAOMI_API_KEY")
    if key and key != "***":
        return key
    # 或者从.env文件读取
    env_path = os.path.expanduser("~/.env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("#"):
                    continue
                parts = line.split("=", 1)
                if len(parts) == 2 and parts[0].strip() == "XIAOMI_API_KEY":
                    val = parts[1].strip().strip('"').strip("'")
                    if val and val != "***":
                        return val
    return None

_ref_voice_cache = None

def load_ref_voice():
    """Load and base64-encode the reference voice file (cached in memory)."""
    global _ref_voice_cache
    if _ref_voice_cache is not None:
        return _ref_voice_cache
    if not os.path.exists(REF_VOICE_PATH):
        return None
    with open(REF_VOICE_PATH, "rb") as f:
        _ref_voice_cache = base64.b64encode(f.read()).decode("utf-8")
    return _ref_voice_cache

def call_mimo_tts(text, model="mimo-v2.5-tts-voiceclone", voice=None,
                   style_instruction=None, api_key=None, api_url=None):
    if not api_key:
        raise ValueError("XIAOMI_API_KEY not set")
    if not api_url:
        api_url = get_api_url()

    messages = []

    if model == "mimo-v2.5-tts-voiceclone":
        ref_b64 = load_ref_voice()
        if not ref_b64:
            raise RuntimeError(f"Reference voice not found: {REF_VOICE_PATH}")
        # 根据文件扩展名设置MIME类型
        ext = os.path.splitext(REF_VOICE_PATH)[1].lower()
        mime = "audio/mp3" if ext == ".mp3" else "audio/wav"
        voice_data = f"data:{mime};base64,{ref_b64}"
        if style_instruction:
            messages.append({"role": "user", "content": style_instruction})
        else:
            messages.append({"role": "user", "content": ""})
    elif model == "mimo-v2.5-tts-voicedesign":
        voice_data = None
        voice_desc = style_instruction or "一个年轻女孩的声音，音色柔和温润，语气轻松自在，自然放松"
        messages.append({"role": "user", "content": voice_desc})
    else:
        voice_data = voice or os.environ.get("MIMO_TTS_VOICE", "冰糖")

    messages.append({"role": "assistant", "content": text})

    audio_cfg = {"format": "wav"}
    if model == "mimo-v2.5-tts-voiceclone":
        audio_cfg["voice"] = voice_data
    elif model == "mimo-v2.5-tts":
        audio_cfg["voice"] = voice_data

    payload = {"model": model, "messages": messages, "audio": audio_cfg}

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(api_url, data=data,
        headers={"Content-Type": "application/json", "api-key": api_key}, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"MiMo TTS API error {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"MiMo TTS connection error: {e.reason}") from e

    try:
        audio_b64 = result["choices"][0]["message"]["audio"]["data"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"Unexpected API response") from e

    return base64.b64decode(audio_b64)

def wav_to_ogg_opus(wav_bytes):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav_bytes)
        wav_path = f.name
    ogg_path = wav_path.replace(".wav", ".ogg")
    try:
        r = subprocess.run(["ffmpeg", "-y", "-i", wav_path, "-c:a", "libopus", "-b:a", "64k", ogg_path],
                          capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            raise RuntimeError(f"ffmpeg error: {r.stderr}")
        with open(ogg_path, "rb") as f:
            return f.read()
    finally:
        for p in (wav_path, ogg_path):
            try: os.unlink(p)
            except: pass

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", "-i", required=True)
    parser.add_argument("--output", "-o", required=True)
    parser.add_argument("--voice", "-v", default=None)
    parser.add_argument("--style", "-s", default=None)
    parser.add_argument("--model", "-m", default=None)
    parser.add_argument("--format", "-f", default=None)
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        text = f.read().strip()
    if not text:
        print("Error: empty text", file=sys.stderr)
        sys.exit(1)

    model = args.model or os.environ.get("MIMO_TTS_MODEL", "mimo-v2.5-tts-voiceclone")
    voice = args.voice or os.environ.get("MIMO_TTS_VOICE", "冰糖")
    api_key = get_api_key()
    if not api_key:
        print("Error: XIAOMI_API_KEY not found", file=sys.stderr)
        sys.exit(1)

    output_path = args.output
    output_format = args.format
    if not output_format:
        ext = os.path.splitext(output_path)[1].lower().lstrip(".")
        output_format = ext if ext in ("wav", "mp3", "ogg") else "ogg"

    try:
        wav_bytes = call_mimo_tts(text=text, model=model, voice=voice,
                                   style_instruction=args.style, api_key=api_key, api_url=get_api_url())
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    if output_format == "ogg":
        audio_bytes = wav_to_ogg_opus(wav_bytes)
    else:
        audio_bytes = wav_bytes

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(audio_bytes)
    print(f"OK: {len(audio_bytes)} bytes -> {output_path}")

if __name__ == "__main__":
    main()
```

---

## 🚀 使用方法

### 命令行调用

```bash
# 基本用法
python3 mimo_tts.py --input text.txt --output output.ogg

# 指定模型
python3 mimo_tts.py --input text.txt --output output.ogg --model mimo-v2.5-tts-voiceclone

# 添加风格指令
python3 mimo_tts.py --input text.txt --output output.ogg --style "语气轻松自然"
```

### 环境变量配置

```bash
export XIAOMI_API_KEY="your-api-key-here"
export XIAOMI_BASE_URL="https://token-plan-cn.xiaomimimo.com/v1"
```

---

## 📌 关键注意事项

### 1. API地址
当前使用: `https://token-plan-cn.xiaomimimo.com/v1`
如有变动，设置环境变量 `XIAOMI_BASE_URL` 覆盖

### 2. 认证方式
- 支持两种方式:
  - Header: `api-key: YOUR_KEY`
  - Header: `Authorization: Bearer YOUR_KEY`

### 3. 参考音频要求
- VoiceClone模式必须提供参考音频
- 音频会被base64编码后上传（每次调用都上传）
- 文件越大，API响应越慢

### 4. 音频格式MIME类型
```python
# MP3文件
voice_data = f"data:audio/mp3;base64,{ref_b64}"

# WAV文件
voice_data = f"data:audio/wav;base64,{ref_b64}"
```

### 5. 响应格式
```json
{
  "choices": [{
    "message": {
      "audio": {
        "data": "base64-encoded-audio..."
      }
    }
  }]
}
```

### 6. 输出格式
- API返回WAV格式
- 如需OGG（用于Telegram语音），用ffmpeg转换:
```bash
ffmpeg -y -i input.wav -c:a libopus -b:a 64k output.ogg
```

---

## 🎯 MiMo TTS 三种模型

| 模型 | 用途 | 特点 |
|------|------|------|
| `mimo-v2.5-tts` | 预设声音 | 冰糖/茉莉/苏打/白桦，支持唱歌 |
| `mimo-v2.5-tts-voicedesign` | 描述生成声音 | 每次生成不同声音，非确定性 |
| `mimo-v2.5-tts-voiceclone` | 克隆声音 | 从参考音频克隆，声音一致性好 |

---

## ⚠️ 常见问题

### Q: 声音每次都不太一样？
A: VoiceClone是概率模型，每次生成会有细微差异，但整体音色保持一致。

### Q: API响应很慢？
A: 主要瓶颈在网络和参考音频大小。优化参考音频（MP3 16kHz 64kbps）可以显著提速。

### Q: 如何改善克隆效果？
A: 
- 使用高质量参考音频（清晰、无噪音）
- 参考音频时长10-30秒为宜
- 避免过度压缩

### Q: 中文支持如何？
A: MiMo支持中文，效果不错。这是选择它的重要原因之一。

---

## 📊 成本参考

| 项目 | 数值 |
|------|------|
| 单条语音成本 | ~0.35元 |
| 每天10条 | ~3.5元/天 |
| 每月 | ~105元/月 |

---

## 🔄 备选方案（支持中文）

| 方案 | 价格 | 中文效果 | 特点 |
|------|------|---------|------|
| Fish Audio | ~0.1-0.2元/条 | ⭐⭐⭐⭐⭐ | 国内平台，中文最专业 |
| ElevenLabs | 免费10000字/月 | ⭐⭐⭐⭐ | 国际标杆 |
| MiniMax | 按字符计费 | ⭐⭐⭐⭐ | 国内大厂 |
| 本地部署（GPT-SoVITS） | 免费（需GPU） | ⭐⭐⭐⭐⭐ | 效果最好，需要8GB+显存 |

---

**文档版本**: v1.0  
**最后更新**: 2026-06-25  
**适用模型**: MiMo V2.5 TTS
