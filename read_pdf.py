import sys
import fitz  # PyMuPDF
import re

pdf_path = sys.argv[1]
search_term = sys.argv[2] if len(sys.argv) > 2 else ""

try:
    doc = fitz.open(pdf_path)
    for page_num in range(len(doc)):
        page = doc.load_page(page_num)
        text = page.get_text()
        if search_term and search_term in text:
            print(f"--- Page {page_num + 1} ---")
            print(text)
    if not search_term:
        pass
except Exception as e:
    print(f"Error reading PDF: {e}")
