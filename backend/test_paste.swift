import Cocoa

let pasteboard = NSPasteboard.general
let oldItems = pasteboard.pasteboardItems?.map { item -> NSPasteboardItem in
    let newItem = NSPasteboardItem()
    for type in item.types {
        if let data = item.data(forType: type) {
            newItem.setData(data, forType: type)
        }
    }
    return newItem
}

pasteboard.clearContents()
pasteboard.setString("hello world", forType: .string)
print("Pasted: \(pasteboard.string(forType: .string) ?? "")")

pasteboard.clearContents()
if let items = oldItems {
    pasteboard.writeObjects(items)
}
print("Restored: \(pasteboard.string(forType: .string) ?? "")")
