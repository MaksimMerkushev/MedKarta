"""
© 2026 МедКарта Казань. Все права защищены.

Экспорт redmadrobot-rnd/rubert-base-pii-ner (из services/pii-ner/model/redmadrobot/source) в ONNX
и динамическое квантование int8. Нужен один раз при установке; сервис работает без Python.
Проверено с torch 2.15.0, transformers 5.22.2, onnx 1.23.2, onnxruntime 1.32.0.
Итоговые файлы сверяются с model.json: при другой версии библиотек квантование может дать другой
файл — тогда скрипт печатает новые SHA-256 и не продолжает, пока их не внесут в model.json вручную.
  HF_HUB_OFFLINE=1 python3 -I services/pii-ner/export-onnx.py services/pii-ner/model/redmadrobot
"""
import hashlib
import json
import os
import shutil
import sys

os.environ['HF_HUB_OFFLINE'] = '1'
import torch  # noqa: E402
from transformers import AutoModelForTokenClassification, AutoTokenizer  # noqa: E402
from onnxruntime.quantization import QuantType, quantize_dynamic  # noqa: E402

out = sys.argv[1]
src = os.path.join(out, 'source')
tok = AutoTokenizer.from_pretrained(src)
model = AutoModelForTokenClassification.from_pretrained(src).eval()
enc = tok('Меня зовут Иван Петров, паспорт 92 04 123456', return_tensors='pt')
fp32 = os.path.join(out, 'model_fp32.onnx')
torch.onnx.export(model, (enc['input_ids'], enc['attention_mask'], enc['token_type_ids']), fp32,
                  input_names=['input_ids', 'attention_mask', 'token_type_ids'], output_names=['logits'],
                  dynamic_axes={k: {0: 'batch', 1: 'seq'} for k in ['input_ids', 'attention_mask', 'token_type_ids', 'logits']}, opset_version=17, dynamo=False)
quantize_dynamic(fp32, os.path.join(out, 'model_int8.onnx'), weight_type=QuantType.QInt8)
os.remove(fp32)
shutil.copy(os.path.join(src, 'config.json'), os.path.join(out, 'config.json'))
vocab = json.load(open(os.path.join(src, 'tokenizer.json'), encoding='utf-8'))['model']['vocab']
with open(os.path.join(out, 'vocab.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(token for token, _ in sorted(vocab.items(), key=lambda item: item[1])))

manifest = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model.json'), encoding='utf-8'))
spec = next(m for m in manifest['models'] if m['name'] == 'redmadrobot')
bad = []
for name, expected in spec['files'].items():
    actual = hashlib.sha256(open(os.path.join(out, name), 'rb').read()).hexdigest()
    if actual != expected:
        bad.append(f'{name}: {actual}')
if bad:
    print('SHA-256 не совпадают с model.json (другая версия библиотек?). Проверьте и внесите вручную:\n  ' + '\n  '.join(bad))
    sys.exit(1)
print('готово: файлы совпадают с model.json')
