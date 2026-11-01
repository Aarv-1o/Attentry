def paragraphs(body, ns):
    out = []
    for p in body.findall("w:p", ns):
        run = p.find("w:r", ns)
        text = run.find("w:t", ns) if run is not None else None
        out.append(text.text if text is not None else "")
    return out
