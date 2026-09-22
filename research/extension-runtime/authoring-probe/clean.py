import pathlib, re, sys
src = pathlib.Path(sys.argv[1]); txt = src.read_text()
# extract first fenced code block if present
m = re.search(r"```[a-zA-Z]*\n(.*?)```", txt, re.S)
if m: txt = m.group(1)
# drop delegate status trailer
txt = re.sub(r"\n?STATUS:\s*DONE\s*$", "", txt.strip()) + "\n"
pathlib.Path(sys.argv[2]).write_text(txt)
