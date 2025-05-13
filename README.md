# ddt-ui-shell

Shell UI for ddt.vim

![2025-02-20_10-10](https://github.com/user-attachments/assets/08f9c02e-bddb-48de-b18b-f90516186b6b)

It supports ANSI colors.

![2025-05-11_11-36](https://github.com/user-attachments/assets/14845735-5d03-4a20-bdf4-690dc16e658c)


## Required

### denops.vim

https://github.com/vim-denops/denops.vim

### ddt.vim

https://github.com/Shougo/ddt.vim

It requires "--unstable-ffi" for |g:denops#server#deno_args|.

## Configuration

```vim
let g:denops#server#deno_args = [
    \   '-q',
    \   '-A',
    \ ]
let g:denops#server#deno_args += ['--unstable-ffi']

call ddt#custom#patch_global(#{
    \   ui: 'shell',
    \ })
```
