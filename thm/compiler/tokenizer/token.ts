


export class token{
    type:string
    value:string|Array<string|any>
    line:number
    pos:number
    end_pos:number|null
    constructor(type:string,value:string|Array<string|any>,line:number,pos:number,end_pos:number|null=null){
        this.type=type
        this.value=value
        this.line=line
        this.pos=pos
        this.end_pos=end_pos
    }

}

export const T:Record<string,string> = {
    // the core 
    newline:"newline",
    eof:"eof",

    // type liteler
    string:"string",
    integer:"integer",
    float:"float"
}