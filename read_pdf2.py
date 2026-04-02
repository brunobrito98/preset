import sys

try:
    import PyPDF2
except ImportError:
    print("PyPDF2 not installed")
    sys.exit(0)

pdf_path = sys.argv[1]
search_term = sys.argv[2] if len(sys.argv) > 2 else ""

try:
    with open(pdf_path, "rb") as f:
        reader = PyPDF2.PdfReader(f)
        for i, page in enumerate(reader.pages):
            text = page.extract_text()
            if search_term and search_term in text:
                print(f"--- Page {i + 1} ---")
                print(text.encode('utf-8', 'ignore').decode('utf-8'))
except Exception as e:
    print(f"Error reading PDF: {e}")
